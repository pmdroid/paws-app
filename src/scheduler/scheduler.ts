import { journal, journalCaught } from "../journal";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  JOB_KIND,
  delegationHasOpenWork,
  holdsExecution,
  isTerminalWorkItemState,
  type RepositoryBinding,
  type WorkBrief,
  type WorkItemState,
} from "../core";
import {
  enqueueJob,
  enqueueJobOnce,
  enqueueOutboxOnce,
  hotFiles,
  immediate,
  latestCandidatePaths,
  mergeLaneSql,
  requeueOrphanedWork,
  runnerCapacityWait,
  saveItemHolds,
  saveQueuePositions,
  savePinnedSlots,
  type ItemHold,
  type PinnedSlot,
  type JobLoop,
  repositoryKey,
  runnerLeaseCutoff,
} from "../db";
import { blockingIssues, readyItems } from "../intake";
import { createAdmission, type ItemAdmission } from "./admission";
import { itemWaits, overlapLine, postWaitKeepalives, type ItemWait } from "./waits";

const TICK = "scheduler.tick";
const RUNNER_SEEN_MS = 60_000;
type Item = {
  id: string;
  delegationId: string;
  issueId: string;
  identifier: string | null;
  position: number;
  absent: number;
  state: WorkItemState;
  version: number;
  createdAt: number;
  cancelRequested: number;
  liveRun: number;
  liveJob: number;
  placed: number;
  placing: number;
  setupHeld: number;
  workspaceId: string | null;
  sessionId: string | null;
  priority: number | null;
  owner: string | null;
  repo: string | null;
  turn: string;
  /** Place in its repository's merge queue, or null outside it. */
  mergePosition: number | null;
  /**
   * When the item became merge-queue work: ready to merge, or sent back to the agent from the
   * merge queue and queued again. Null for any other item.
   */
  mergeAt: number | null;
};
type Admission = {
  itemId: string;
  repositoryKey: string;
  sessionId: string | null;
};
export type SchedulerOptions = {
  now?: number;
  admission?: ItemAdmission;
  defaultRepository?: RepositoryBinding | null;
  handoffForItem?: (itemId: string) => string | undefined;
  sessionFor?: (itemId: string) => string | null;
  onWaiting?: (itemIds: readonly string[]) => void;
  /**
   * Whether the item's owner has a runner they may use. False keeps the item out of the slot
   * line: no runner slot would ever be theirs, so it waits for runner setup instead. Null or
   * unset counts as true. Reads SQLite only.
   */
  ownerHasRunner?: (itemId: string) => boolean | null;
  /** Queued items whose owner has no runner they may use, after every admission pass. */
  onRunnerSetup?: (itemIds: readonly string[]) => void;
  onWaits?: (waits: readonly ItemWait[]) => void;
  ownerCap?: number | null;
  log?: (line: string) => void;
};

const HOLD_LINES: Record<ItemHold["reason"], string> = {
  blocked: "blocked by another issue",
  project: "its project has not released it yet",
  reconciling: "Linear changes are still syncing",
  snapshot: "reading its dependencies from Linear",
  cap: "its owner already runs the most tasks at once",
  slot: "no free slot on any runner",
  workspace: "no Linear workspace",
  overlap: "waiting for other work that changes the same files to merge",
};

function holdLine(hold: ItemHold): string {
  if (hold.reason === "overlap" && hold.blockers.length)
    return overlapLine(hold.blockers[0]!, hold.files ?? []);
  return hold.reason === "blocked" && hold.blockers.length
    ? `blocked by ${hold.blockers.join(", ")}`
    : HOLD_LINES[hold.reason];
}

type Overlap = { blocker: string; files: string[] };

/**
 * Holds work that would conflict again in the merge queue. A queued item whose latest candidate
 * changes a hot file, one that caused a merge-queue conflict in the last week, waits while a
 * running or merge-queue item in the same repository changes that file too, until that one
 * merges. An item without a candidate is never held: Paws cannot know its files.
 */
function overlapGate(db: Database, now: number) {
  const hot = new Map<string, Set<string>>();
  for (const file of hotFiles(db, now)) {
    const key = file.repository.toLowerCase();
    hot.set(key, (hot.get(key) ?? new Set()).add(file.path));
  }
  const paths = hot.size ? latestCandidatePaths(db) : new Map<string, string[]>();
  return (item: Item, occupants: readonly Item[]): Overlap | null => {
    if (!item.owner || !item.repo) return null;
    const key = repositoryKey(item.owner, item.repo);
    const files = hot.get(key);
    const mine = files ? (paths.get(item.id) ?? []).filter((path) => files.has(path)) : [];
    if (!mine.length) return null;
    for (const other of occupants) {
      if (other.id === item.id || !other.owner || !other.repo) continue;
      if (repositoryKey(other.owner, other.repo) !== key) continue;
      const theirs = new Set(paths.get(other.id) ?? []);
      const shared = mine.filter((path) => theirs.has(path));
      if (shared.length) return { blocker: other.identifier ?? other.id, files: shared };
    }
    return null;
  };
}

/**
 * Identifiers of the Linear issues that hold `itemId` as blocked, by the rules readiness uses.
 * Empty means readiness and the blockers disagree; the scheduler journals that as an inconsistency.
 */
export function openBlockers(db: Database, itemId: string): string[] {
  return blockingIssues(db, itemId);
}

export function schedulerPaths(paths: readonly string[]): string[] {
  if (!paths.length) return ["*"];
  return [
    ...new Set(
      paths.map((value) => {
        const path = value.trim().replace(/\/$/, "");
        if (path === "*") return path;
        if (
          !path ||
          path.startsWith("/") ||
          path.includes("\\") ||
          Array.from(path).some((character) => character.charCodeAt(0) <= 32) ||
          path.split("/").some((part) => !part || part === "." || part === "..")
        )
          throw new Error("Scheduling paths must be repository relative");
        const wildcard = Array.from(path).findIndex((character) => "*?[]{}".includes(character));
        if (wildcard < 0) return path;
        const prefix = path.slice(0, wildcard);
        const slash = prefix.lastIndexOf("/");
        return slash < 0 ? "*" : prefix.slice(0, slash) || "*";
      }),
    ),
  ].sort();
}

export function saveSchedulingContext(
  db: Database,
  input: {
    itemId: string;
    projectId?: string | null;
    /** Linear user id of the project lead. Unknown keeps the saved lead. */
    projectLeadId?: string | null;
    priority?: number;
    paths?: readonly string[] | null;
  },
): void {
  if (input.projectId != null && !input.projectId.trim()) throw new Error("Invalid Linear project");
  if (input.projectLeadId != null && !input.projectLeadId.trim())
    throw new Error("Invalid Linear project lead");
  const priority = input.priority ?? 0;
  if (!Number.isInteger(priority) || priority < 0 || priority > 4)
    throw new Error("Invalid Linear priority");
  const paths = input.paths == null ? null : schedulerPaths(input.paths);
  db.run(
    `INSERT INTO work_item_scheduling(item_id,project_id,project_known,priority,paths,project_lead_id)
    VALUES(?,?,?,?,?,?)
    ON CONFLICT(item_id) DO UPDATE SET project_id=excluded.project_id,project_known=excluded.project_known,
    priority=excluded.priority,paths=excluded.paths,
    project_lead_id=CASE WHEN ? THEN excluded.project_lead_id ELSE work_item_scheduling.project_lead_id END`,
    [
      input.itemId,
      input.projectId ?? null,
      Number(input.projectId !== undefined),
      priority,
      paths === null ? null : JSON.stringify(paths),
      input.projectId === null ? null : (input.projectLeadId ?? null),
      Number(input.projectLeadId !== undefined || input.projectId === null),
    ],
  );
}

/** Linear user id of the item's project lead as last saved from Linear, or null. */
export function projectLeadId(db: Database, itemId: string): string | null {
  return (
    db
      .query<{ lead: string | null }, [string]>(
        "SELECT project_lead_id AS lead FROM work_item_scheduling WHERE item_id=?",
      )
      .get(itemId)?.lead ?? null
  );
}

export function hintedPaths(brief: string | null): string[] {
  const description = brief === null ? null : (JSON.parse(brief) as WorkBrief).issue.description;
  const hints = description?.match(/^\s*paths:\s*(.+)$/gim);
  if (!hints?.length) return ["*"];
  try {
    return schedulerPaths(
      hints.flatMap((line) => line.replace(/^\s*paths:\s*/i, "").split(/[,\s]+/)),
    );
  } catch (caughtError1) {
    journalCaught(caughtError1, "scheduler.hintedPaths.schedulerPaths", null);
    return ["*"];
  }
}

function allItems(db: Database, now: number): Item[] {
  return db
    .query<
      Item,
      [number, number, number]
    >(`SELECT i.id,i.delegation_id AS delegationId,i.linear_issue_id AS issueId,
    i.linear_identifier AS identifier,i.position,
    EXISTS(SELECT 1 FROM work_item_specification f WHERE f.item_id=i.id AND f.present=0) AS absent,
    i.state,i.version,i.created_at AS createdAt,i.cancel_requested AS cancelRequested,
    EXISTS(SELECT 1 FROM run live WHERE live.item_id=i.id AND live.status IN ('active','provisioning')) AS liveRun,
    EXISTS(SELECT 1 FROM job held WHERE json_extract(held.payload,'$.itemId')=i.id
      AND held.status='running' AND (held.locked_until IS NULL OR held.locked_until>?)
      AND (held.queue IN ('item.start','run.resume','run.reverify','github.merge')
        OR held.queue LIKE 'github.merge.%')) AS liveJob,
    EXISTS(SELECT 1 FROM run p JOIN runner_work w ON w.run_id=p.id WHERE p.item_id=i.id
      AND ((w.ended_at IS NULL AND w.lease_until>?) OR p.status IN ('active','provisioning'))) AS placed,
    EXISTS(SELECT 1 FROM job start WHERE json_extract(start.payload,'$.itemId')=i.id
      AND start.status='running' AND (start.locked_until IS NULL OR start.locked_until>?)
      AND start.queue IN ('${JOB_KIND.start}','${JOB_KIND.resume}','${JOB_KIND.reverify}')) AS placing,
    EXISTS(SELECT 1 FROM runner_setup_hold h WHERE h.item_id=i.id) AS setupHeld,
    w.id AS workspaceId,s.session_id AS sessionId,c.priority,r.owner,r.repo,
    COALESCE('user:'||i.owner_user_id,'') AS turn,
    CASE WHEN e.item_id IS NULL THEN NULL ELSE (SELECT count(*) FROM merge_queue_entry o
      JOIN work_item ow ON ow.id=o.item_id WHERE o.repository=e.repository
      AND ow.state IN ('merge_queue','verifying') AND ow.cancel_requested=0
      AND (o.ready_at<e.ready_at OR (o.ready_at=e.ready_at AND o.item_id<=e.item_id))) END AS mergePosition,
    COALESCE(e.ready_at,CASE WHEN i.state='queued' THEN (SELECT ev.at FROM work_item_event ev
      WHERE ev.id=(SELECT MAX(last.id) FROM work_item_event last WHERE last.item_id=i.id)
      AND ev.kind='restart' AND (ev.from_state='merge_queue' OR (ev.from_state='verifying'
        AND (SELECT p.from_state FROM work_item_event p WHERE p.item_id=i.id AND p.id<ev.id
          AND p.to_state='verifying' AND p.from_state<>'verifying' ORDER BY p.id DESC LIMIT 1)='merge_queue'))) END) AS mergeAt
    FROM work_item i
    LEFT JOIN merge_queue_entry e ON e.item_id=i.id AND i.state IN ('merge_queue','verifying')
    LEFT JOIN linear_session s ON s.session_id=i.session_key
    LEFT JOIN workspace w ON w.linear_organization_id=s.organization_id
    LEFT JOIN work_item_scheduling c ON c.item_id=i.id
    LEFT JOIN work_item_repository r ON r.item_id=i.id
    WHERE ${delegationHasOpenWork("i.delegation_id")} OR i.state IN ('running','verifying','recovering','awaiting_input','paused','merge_queue')
    OR EXISTS(SELECT 1 FROM run live WHERE live.item_id=i.id AND live.status IN ('active','provisioning'))`)
    .all(now, runnerLeaseCutoff(now), now);
}

function taskSlots(
  db: Database,
  now: number,
): { total: number; busy: number; open: Map<string, number> } | null {
  const runners = db
    .query<{ id: string; capacity: number; used: number }, [number, number, number]>(
      `SELECT r.id,COALESCE((SELECT MIN(c.capacity,COALESCE(c.desired,16)) FROM runner_capacity c WHERE c.runner_id=r.id),1) AS capacity,
       (SELECT count(*) FROM runner_work w WHERE w.runner_id=r.id AND ((w.ended_at IS NULL AND w.lease_until>?) OR EXISTS(SELECT 1 FROM run held WHERE held.id=w.run_id AND held.status IN ('active','provisioning')))) +
       (SELECT count(*) FROM runner_helper x WHERE x.runner_id=r.id AND x.ended_at IS NULL AND x.expires_at>?) AS used
       FROM runner r WHERE r.status='active' AND r.revoked_at IS NULL AND r.last_seen_at>?`,
    )
    .all(runnerLeaseCutoff(now), now, now - RUNNER_SEEN_MS);
  if (!runners.length) return null;
  return {
    total: runners.reduce((total, runner) => total + runner.capacity, 0),
    busy: runners.reduce((busy, runner) => busy + Math.min(runner.used, runner.capacity), 0),
    open: new Map(
      runners.map((runner) => [
        runner.id,
        runner.capacity - Math.min(runner.used, runner.capacity),
      ]),
    ),
  };
}

type PinnedWait = {
  itemId: string;
  jobId: number;
  /** The pinned runner, or for unpinned merge-queue work every busy runner it may use. */
  runnerIds: readonly string[];
};

/**
 * Items whose resume or reverify job waits for a runner slot. A wait for the runner its run is
 * pinned to holds that runner's next free slot. A wait on an offline pinned runner, or one past
 * its hold, holds nothing: placement then may move the run. Merge-queue work that is not pinned,
 * such as a re-verify that only runs the checks and the review, holds the next slot that frees on
 * any of the runners it waits for.
 */
function pinnedWaits(db: Database, now: number): PinnedWait[] {
  return db
    .query<
      {
        itemId: string;
        jobId: number;
        runnerId: string | null;
        online: number;
        merging: number;
        payload: string;
      },
      [number]
    >(
      `SELECT i.id AS itemId,j.id AS jobId,w.runner_id AS runnerId,r.id IS NOT NULL AS online,
       EXISTS(SELECT 1 FROM merge_queue_entry e WHERE e.item_id=i.id) AS merging,j.payload
       FROM work_item i
       JOIN job j ON j.id=(SELECT q.id FROM job q WHERE q.status='pending'
         AND q.queue IN ('${JOB_KIND.resume}','${JOB_KIND.reverify}')
         AND json_extract(q.payload,'$.itemId')=i.id ORDER BY q.id DESC LIMIT 1)
       LEFT JOIN runner_work w ON w.run_id=i.current_run_id
       LEFT JOIN runner r ON r.id=w.runner_id
         AND r.status='active' AND r.revoked_at IS NULL AND r.last_seen_at>?
       WHERE i.state IN ('recovering','verifying','merge_queue') AND i.cancel_requested=0`,
    )
    .all(now - RUNNER_SEEN_MS)
    .flatMap(({ payload, runnerId, online, merging, ...wait }): PinnedWait[] => {
      const capacity = runnerCapacityWait(JSON.parse(payload));
      if (!capacity || now - capacity.since >= (capacity.holdMs ?? Infinity)) return [];
      const pinned = online && runnerId !== null && capacity.runnerIds.includes(runnerId);
      if (pinned && (!merging || capacity.runnerIds.length === 1))
        return [{ ...wait, runnerIds: [runnerId] }];
      return merging && capacity.runnerIds.length
        ? [{ ...wait, runnerIds: capacity.runnerIds }]
        : [];
    });
}

function holdsSession(item: Item): boolean {
  return holdsExecution(item) || item.state === "awaiting_input" || item.state === "paused";
}

function footprint(item: Item, options: SchedulerOptions): Admission {
  const repository =
    item.owner && item.repo
      ? `${item.owner}/${item.repo}`
      : options.defaultRepository
        ? `${options.defaultRepository.owner}/${options.defaultRepository.repo}`
        : "unbound";
  return {
    itemId: item.id,
    repositoryKey: repository.toLowerCase(),
    sessionId: item.sessionId,
  };
}

function fairOrder(
  candidates: readonly Item[],
  running: ReadonlyMap<string, number>,
  cap: number | null,
): { item: Item; capped: boolean }[] {
  const lines = new Map<string, Item[]>();
  for (const item of candidates) lines.set(item.turn, [...(lines.get(item.turn) ?? []), item]);
  const rank = new Map(candidates.map((item, index) => [item.id, index]));
  const load = new Map(running);
  const order: { item: Item; capped: boolean }[] = [];
  while (lines.size) {
    const head = (turn: string) => rank.get(lines.get(turn)![0]!.id)!;
    // Merge-queue work leads its owner's line and goes before any owner's other work.
    const merging = (turn: string) => lines.get(turn)![0]!.mergeAt !== null;
    const ahead = (turn: string, best: string) => {
      if (merging(turn) !== merging(best)) return merging(turn);
      const difference = (load.get(turn) ?? 0) - (load.get(best) ?? 0);
      return difference < 0 || (difference === 0 && head(turn) < head(best));
    };
    const next = [...lines.keys()].reduce((best, turn) => (ahead(turn, best) ? turn : best));
    const line = lines.get(next)!;
    const item = line.shift()!;
    if (!line.length) lines.delete(next);
    const count = load.get(next) ?? 0;
    order.push({ item, capped: cap !== null && count >= cap });
    load.set(next, count + 1);
  }
  return order;
}

function depths(db: Database, items: Item[]): Map<string, number> {
  const ids = new Map<string, string>();
  for (const item of items) {
    if (isTerminalWorkItemState(item.state) && ids.has(item.issueId)) continue;
    ids.set(item.issueId, item.id);
  }
  const edges = db
    .query<{ blocker: string; blocked: string }, []>(
      "SELECT blocker_linear_issue_id AS blocker,blocked_linear_issue_id AS blocked FROM task_block",
    )
    .all();
  const children = new Map<string, string[]>();
  for (const edge of edges) {
    const parent = ids.get(edge.blocker),
      child = ids.get(edge.blocked);
    if (parent && child) children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const result = new Map<string, number>();
  const visit = (id: string, seen: Set<string>): number => {
    if (seen.has(id)) return 0;
    const saved = result.get(id);
    if (saved !== undefined) return saved;
    const next = new Set(seen).add(id);
    const depth = 1 + Math.max(0, ...(children.get(id) ?? []).map((child) => visit(child, next)));
    result.set(id, depth);
    return depth;
  };
  for (const item of items) visit(item.id, new Set());
  return result;
}

function yieldIdleMergeSessions(
  db: Database,
  items: readonly Item[],
  ready: ReadonlySet<string>,
  admission: ItemAdmission,
  now: number,
): void {
  for (const item of items) {
    if (
      item.state !== "merge_queue" ||
      item.absent ||
      !admission.canDispatchDelegation(item.delegationId) ||
      !items.some(
        (other) =>
          other.id !== item.id && other.delegationId === item.delegationId && ready.has(other.id),
      )
    )
      continue;
    db.run(
      `UPDATE linear_session SET active_item_id=NULL WHERE active_item_id=?
       AND NOT EXISTS(SELECT 1 FROM run WHERE item_id=? AND status IN ('active','provisioning'))
       AND NOT EXISTS(SELECT 1 FROM job WHERE status='running' AND (locked_until IS NULL OR locked_until>?)
         AND json_extract(payload,'$.itemId')=?
         AND (queue IN ('${JOB_KIND.start}','${JOB_KIND.resume}','${JOB_KIND.reverify}') OR ${mergeLaneSql("job")}))`,
      [item.id, item.id, now, item.id],
    );
  }
}

function reportDependencyCycles(
  db: Database,
  items: readonly Item[],
  admission: ItemAdmission,
  sessionFor: (itemId: string) => string | null,
  now: number,
): void {
  const delegations = new Map<string, Item[]>();
  for (const item of items)
    if (!item.absent)
      delegations.set(item.delegationId, [...(delegations.get(item.delegationId) ?? []), item]);
  for (const [delegationId, members] of delegations) {
    const workspaceId = members.find((member) => member.workspaceId)?.workspaceId;
    if (!workspaceId || !admission.canDispatchDelegation(delegationId)) continue;
    let held: Item[];
    try {
      held = members
        .sort((left, right) => left.position - right.position)
        .filter(
          (member) =>
            readyItems(db, { itemId: member.id, workspaceId }).cycleHeldItemIds.length > 0,
        );
    } catch (caughtError2) {
      journalCaught(caughtError2, "scheduler.reportDependencyCycles.filter", null);
      continue;
    }
    if (!held.length) continue;
    const session = held.map((member) => sessionFor(member.id)).find((id) => id !== null);
    if (!session) continue;
    const digest = createHash("sha256")
      .update(JSON.stringify(held.map((member) => member.id).sort()))
      .digest("hex");
    enqueueOutboxOnce(db, {
      target: "linear",
      op: "activity",
      orderingKey: session,
      idempotencyKey: `dependency-cycle:${delegationId}:${digest}`,
      payload: {
        sessionId: session,
        kind: "thought",
        body: `Linear dependencies contain a cycle. Update the dependencies in Linear to release this work: ${held.map((member) => member.identifier).join(", ")}. Unaffected work can continue.`,
      },
      now,
    });
  }
}

export function dispatch(db: Database, options: SchedulerOptions = {}): string[] {
  if (db.inTransaction) throw new Error("Dispatch runs after the transition commits");
  const now = options.now ?? Date.now();
  const admission = options.admission ?? createAdmission({ db });
  const result = immediate(db, () => {
    requeueOrphanedWork(db, now);
    const items = allItems(db, now);
    const byId = new Map(items.map((item) => [item.id, item]));
    const starts = items
      // A runner-setup hold waits for the delegator, not for a slot: it is neither started nor
      // counted as waiting, so no queue notice or start timeout reaches it. Only the
      // `runner_setup.check` job ends it, after a runner write, never this tick.
      .filter(
        (item) =>
          item.state === "queued" && !item.cancelRequested && !item.absent && !item.setupHeld,
      )
      .map((item) => ({ item, start: admission.canStart(item.id) }));
    const ready = new Set(starts.filter(({ start }) => start.ok).map(({ item }) => item.id));
    yieldIdleMergeSessions(db, items, ready, admission, now);
    if (options.sessionFor) reportDependencyCycles(db, items, admission, options.sessionFor, now);
    const saved = db
      .query<Admission & { jobId: number; status: string; lockedUntil: number | null }, []>(
        `SELECT a.item_id AS itemId,a.job_id AS jobId,a.repository_key AS repositoryKey,
       a.session_id AS sessionId,j.status,j.locked_until AS lockedUntil FROM scheduler_admission a JOIN job j ON j.id=a.job_id`,
      )
      .all();
    const held: Admission[] = [];
    for (const row of saved) {
      const item = byId.get(row.itemId);
      if (
        (item && holdsSession(item)) ||
        (row.status === "running" && (row.lockedUntil === null || row.lockedUntil > now))
      ) {
        held.push(row);
        continue;
      }
      if (
        item?.state === "queued" &&
        ready.has(item.id) &&
        ["pending", "running"].includes(row.status)
      ) {
        const current = footprint(item, options);
        if (current.repositoryKey === row.repositoryKey) {
          held.push(current);
          continue;
        }
      }
      db.run(
        `UPDATE job SET status='cancelled',finished_at=?,locked_by=NULL,locked_until=NULL
        WHERE id=? AND (status='pending' OR (status='running' AND locked_until<=?))`,
        [now, row.jobId, now],
      );
      db.run("DELETE FROM scheduler_admission WHERE item_id=?", [row.itemId]);
    }
    for (const item of items)
      if (holdsSession(item) && !held.some((entry) => entry.itemId === item.id)) {
        const entry = footprint(item, options);
        const job = db
          .query<{ id: number }, [string]>(
            `SELECT id FROM job WHERE status IN ('pending','running')
            AND queue IN ('${JOB_KIND.start}','${JOB_KIND.resume}','${JOB_KIND.reverify}')
            AND json_extract(payload,'$.itemId')=? ORDER BY id DESC LIMIT 1`,
          )
          .get(item.id);
        if (job)
          db.run(
            `INSERT OR IGNORE INTO scheduler_admission(item_id,job_id,project_key,repository_key,session_id,paths,hot,created_at)
            VALUES(?,?,?,?,?,?,?,?)`,
            [item.id, job.id, "*", entry.repositoryKey, entry.sessionId, "[]", 0, now],
          );
        held.push(entry);
      }
    const depth = depths(db, items);
    // Merge-queue work goes first, in merge order: finished pull requests never wait behind new
    // implementation work.
    const rank = (a: Item, b: Item) =>
      Number(a.mergeAt === null) - Number(b.mergeAt === null) ||
      (a.mergePosition ?? Number.MAX_SAFE_INTEGER) - (b.mergePosition ?? Number.MAX_SAFE_INTEGER) ||
      (a.mergeAt ?? 0) - (b.mergeAt ?? 0) ||
      (depth.get(b.id) ?? 0) - (depth.get(a.id) ?? 0) ||
      (a.priority || 5) - (b.priority || 5) ||
      a.createdAt - b.createdAt ||
      a.id.localeCompare(b.id);
    const candidates = items.filter((item) => ready.has(item.id)).sort(rank);
    const slots = taskSlots(db, now);
    const pins = slots
      ? pinnedWaits(db, now)
          .filter((pin) => byId.has(pin.itemId) && pin.runnerIds.some((id) => slots.open.has(id)))
          .sort((a, b) => rank(byId.get(a.itemId)!, byId.get(b.itemId)!))
      : [];
    let pinned = 0;
    const reservedSlots = new Map<number, PinnedSlot>();
    // Pinned waits ranked ahead of `before` take their runner's next free slot, and are woken
    // when that slot is free now. On a full runner the wait holds the slot that frees next. The
    // reservation is saved on the wait's job, so runner placement keeps queued work off it. An
    // unpinned merge-queue wait takes a free slot on any of its runners; while all are full it
    // holds nothing, and the next tick gives it the first slot that frees.
    const claimPinned = (before?: Item) => {
      for (; pinned < pins.length; pinned += 1) {
        const pin = pins[pinned]!;
        if (before && rank(byId.get(pin.itemId)!, before) > 0) return;
        const runnerId =
          pin.runnerIds.length === 1
            ? pin.runnerIds[0]!
            : pin.runnerIds.find((id) => (slots!.open.get(id) ?? 0) > 0);
        if (runnerId === undefined) continue;
        const open = slots!.open.get(runnerId) ?? 0;
        slots!.open.set(runnerId, open - 1);
        // Queued work ranked ahead already took every free slot; this wait waits its turn.
        if (open > 0 && free <= 0) continue;
        reservedSlots.set(pin.jobId, { runnerId, order: pinned });
        if (open <= 0) continue;
        db.run("UPDATE job SET run_at=? WHERE id=? AND status='pending' AND run_at>?", [
          now,
          pin.jobId,
          now,
        ]);
        free -= 1;
      }
    };
    const reserved = items.filter(
      (item) =>
        !item.placed &&
        (item.placing ||
          (item.state === "queued" && held.some((entry) => entry.itemId === item.id))),
    ).length;
    let free = slots === null ? Infinity : slots.total - slots.busy - reserved;
    const running = new Map<string, number>();
    for (const item of items)
      if (
        holdsExecution(item) ||
        (item.state === "queued" && held.some((entry) => entry.itemId === item.id))
      )
        running.set(item.turn, (running.get(item.turn) ?? 0) + 1);
    const cap = options.ownerCap ?? null;
    const overlapping = overlapGate(db, now);
    const occupants = items.filter(
      (item) =>
        holdsExecution(item) ||
        item.state === "merge_queue" ||
        (item.state === "queued" && held.some((entry) => entry.itemId === item.id)),
    );
    const overlaps = new Map<string, Overlap>();
    const unheld = candidates.filter((item) => {
      if (held.some((entry) => entry.itemId === item.id)) return false;
      const overlap = overlapping(item, occupants);
      if (overlap) overlaps.set(item.id, overlap);
      return overlap === null;
    });
    const order = fairOrder(unheld, running, cap);
    // Only checked while runners exist, so a workspace without runners behaves as before.
    const ownerHasRunner = slots === null ? undefined : options.ownerHasRunner;
    const setup = new Set(
      ownerHasRunner
        ? order.filter(({ item }) => ownerHasRunner(item.id) === false).map(({ item }) => item.id)
        : [],
    );
    const admitted: string[] = [];
    for (const { item, capped } of order) {
      if (capped || setup.has(item.id)) continue;
      claimPinned(item);
      if (free <= 0) break;
      const next = footprint(item, options);
      if (held.some((entry) => byId.get(entry.itemId)?.issueId === item.issueId)) continue;
      // Work admitted earlier in this tick runs too.
      const overlap = overlapping(item, occupants);
      if (overlap) {
        overlaps.set(item.id, overlap);
        continue;
      }
      db.run(
        `UPDATE job SET status='cancelled',finished_at=? WHERE queue=?
        AND status='pending' AND json_extract(payload,'$.itemId')=?`,
        [now, JOB_KIND.start, item.id],
      );
      const handoff = options.handoffForItem?.(item.id);
      const resume = db
        .query<{ id: number }, [string]>(
          "SELECT id FROM job WHERE queue='run.resume' AND status='pending' AND json_extract(payload,'$.itemId')=? ORDER BY id DESC LIMIT 1",
        )
        .get(item.id);
      const jobId =
        resume?.id ??
        enqueueJob(db, {
          queue: JOB_KIND.start,
          payload: { itemId: item.id, ...(handoff ? { handoff } : {}) },
          now,
        });
      db.run(
        `INSERT INTO scheduler_admission(item_id,job_id,project_key,repository_key,session_id,paths,hot,created_at)
        VALUES(?,?,?,?,?,?,?,?)`,
        [item.id, jobId, "*", next.repositoryKey, next.sessionId, "[]", 0, now],
      );
      held.push(next);
      occupants.push(item);
      admitted.push(item.id);
      free -= 1;
    }
    claimPinned();
    savePinnedSlots(db, reservedSlots);
    const waiting = order.filter(
      ({ item }) => !admitted.includes(item.id) && !setup.has(item.id) && !overlaps.has(item.id),
    );
    const line = [
      ...waiting.filter(({ capped }) => !capped),
      ...waiting.filter(({ capped }) => capped),
    ].map(({ item }) => item.id);
    saveQueuePositions(
      db,
      line,
      slots ? { busy: slots.total - Math.max(free, 0), total: slots.total } : null,
      now,
      new Map(waiting.flatMap(({ item, capped }) => (capped && cap ? [[item.id, cap]] : []))),
    );
    const holds: ItemHold[] = [
      ...starts.flatMap(({ item, start }): ItemHold[] =>
        start.ok || start.held === "missing" || start.held === "cancelled"
          ? []
          : [
              {
                itemId: item.id,
                reason: start.held,
                blockers: start.held === "blocked" ? openBlockers(db, item.id) : [],
              },
            ],
      ),
      ...waiting.map(({ item, capped }): ItemHold => ({
        itemId: item.id,
        reason: capped ? "cap" : "slot",
        blockers: [],
      })),
      ...[...overlaps].map(([itemId, overlap]): ItemHold => ({
        itemId,
        reason: "overlap",
        blockers: [overlap.blocker],
        files: overlap.files,
      })),
    ];
    const changes = saveItemHolds(db, holds).map((change) => {
      const name =
        byId.get(change.itemId)?.identifier ??
        db
          .query<{ name: string | null }, [string]>(
            "SELECT linear_identifier AS name FROM work_item WHERE id=?",
          )
          .get(change.itemId)?.name ??
        change.itemId;
      if (change.held?.reason === "blocked" && !change.held.blockers.length)
        journal(`scheduler inconsistency: item ${name} is held as blocked but has no open blocker`);
      return change.held
        ? `item ${name} held: ${holdLine(change.held)}`
        : `item ${name} no longer held`;
    });
    const waits = itemWaits(
      db,
      items.map((item) => (admitted.includes(item.id) ? { ...item, liveJob: 1 } : item)),
      holds,
      new Map(slots ? line.map((id, index) => [id, index + 1]) : []),
    );
    postWaitKeepalives(db, waits, now);
    return {
      admitted,
      waits,
      waiting: waiting.map(({ item }) => item.id),
      setup: [...setup],
      changes,
    };
  });
  if (options.log) for (const line of result.changes) options.log(line);
  options.onWaiting?.(result.waiting);
  options.onRunnerSetup?.(result.setup);
  options.onWaits?.(result.waits);
  return result.admitted;
}

export function registerScheduler(jobs: JobLoop, tick: () => void, now = Date.now()): void {
  jobs.register(TICK, tick);
  enqueueJobOnce(jobs.db, { queue: TICK, jobKey: TICK, recurringEveryMs: 30_000, now });
}
