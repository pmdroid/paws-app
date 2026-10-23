import type { Database } from "bun:sqlite";
import {
  JOB_KIND,
  delegationHasOpenWork,
  holdsExecution as itemHoldsExecution,
  isTerminalWorkItemState,
  type RepositoryBinding,
  type WorkBrief,
  type WorkItemState,
} from "../core";
import {
  enqueueJob,
  enqueueJobOnce,
  immediate,
  requeueOrphanedWork,
  saveQueuePositions,
  type JobLoop,
} from "../db";
import { readyItems } from "../intake";

const TICK = "scheduler.tick";
const RUNNER_SEEN_MS = 60_000;
type Item = {
  id: string;
  delegationId: string;
  issueId: string;
  state: WorkItemState;
  version: number;
  createdAt: number;
  cancelRequested: number;
  liveRun: number;
  liveJob: number;
  placed: number;
  placing: number;
  workspaceId: string | null;
  sessionId: string | null;
  priority: number | null;
  owner: string | null;
  repo: string | null;
  turn: string;
};
type Admission = {
  itemId: string;
  repositoryKey: string;
  sessionId: string | null;
};
export type SchedulerOptions = {
  now?: number;
  legacyReadyItemIds?: readonly string[];
  defaultRepository?: RepositoryBinding | null;
  canDispatchDelegation?: (delegationId: string) => boolean;
  handoffForItem?: (itemId: string) => string | undefined;
  ownerCap?: number | null;
};

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
    priority?: number;
    paths?: readonly string[] | null;
  },
): void {
  if (input.projectId != null && !input.projectId.trim()) throw new Error("Invalid Linear project");
  const priority = input.priority ?? 0;
  if (!Number.isInteger(priority) || priority < 0 || priority > 4)
    throw new Error("Invalid Linear priority");
  const paths = input.paths == null ? null : schedulerPaths(input.paths);
  db.run(
    `INSERT INTO work_item_scheduling(item_id,project_id,project_known,priority,paths) VALUES(?,?,?,?,?)
    ON CONFLICT(item_id) DO UPDATE SET project_id=excluded.project_id,project_known=excluded.project_known,
    priority=excluded.priority,paths=excluded.paths`,
    [
      input.itemId,
      input.projectId ?? null,
      Number(input.projectId !== undefined),
      priority,
      paths === null ? null : JSON.stringify(paths),
    ],
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
  } catch {
    return ["*"];
  }
}

function allItems(db: Database, now: number): Item[] {
  return db
    .query<
      Item,
      [number, number, number]
    >(`SELECT i.id,i.delegation_id AS delegationId,i.linear_issue_id AS issueId,
    i.state,i.version,i.created_at AS createdAt,i.cancel_requested AS cancelRequested,
    EXISTS(SELECT 1 FROM run live WHERE live.item_id=i.id AND live.status IN ('active','provisioning')) AS liveRun,
    EXISTS(SELECT 1 FROM job held WHERE json_extract(held.payload,'$.itemId')=i.id
      AND held.status='running' AND (held.locked_until IS NULL OR held.locked_until>?)
      AND (held.queue IN ('item.start','run.resume','run.reverify','github.merge')
        OR held.queue LIKE 'github.merge.%' OR held.lane='merge')) AS liveJob,
    EXISTS(SELECT 1 FROM run p JOIN runner_work w ON w.run_id=p.id WHERE p.item_id=i.id
      AND ((w.ended_at IS NULL AND w.lease_until>?) OR p.status IN ('active','provisioning'))) AS placed,
    EXISTS(SELECT 1 FROM job start WHERE json_extract(start.payload,'$.itemId')=i.id
      AND start.status='running' AND (start.locked_until IS NULL OR start.locked_until>?)
      AND start.queue IN ('${JOB_KIND.start}','${JOB_KIND.resume}','${JOB_KIND.reverify}')) AS placing,
    w.id AS workspaceId,s.session_id AS sessionId,c.priority,r.owner,r.repo,
    COALESCE('project:'||i.project_approval_id,'user:'||i.owner_user_id,'') AS turn
    FROM work_item i
    LEFT JOIN linear_session s ON s.session_id=i.session_key
    LEFT JOIN workspace w ON w.linear_organization_id=s.organization_id
    LEFT JOIN work_item_scheduling c ON c.item_id=i.id
    LEFT JOIN work_item_repository r ON r.item_id=i.id
    WHERE ${delegationHasOpenWork("i.delegation_id")} OR i.state IN ('running','verifying','recovering','awaiting_input','paused','merge_queue')
    OR EXISTS(SELECT 1 FROM run live WHERE live.item_id=i.id AND live.status IN ('active','provisioning'))`)
    .all(now, now, now);
}

function holdsExecution(item: Item): boolean {
  return itemHoldsExecution({
    state: item.state,
    liveRun: Boolean(item.liveRun),
    liveJob: Boolean(item.liveJob),
  });
}

function taskSlots(db: Database, now: number): { total: number; busy: number } | null {
  const runners = db
    .query<{ capacity: number; used: number }, [number, number, number]>(
      `SELECT COALESCE((SELECT MIN(c.capacity,COALESCE(c.desired,16)) FROM runner_capacity c WHERE c.runner_id=r.id),1) AS capacity,
       (SELECT count(*) FROM runner_work w WHERE w.runner_id=r.id AND ((w.ended_at IS NULL AND w.lease_until>?) OR EXISTS(SELECT 1 FROM run held WHERE held.id=w.run_id AND held.status IN ('active','provisioning')))) +
       (SELECT count(*) FROM runner_helper x WHERE x.runner_id=r.id AND x.ended_at IS NULL AND x.expires_at>?) AS used
       FROM runner r WHERE r.status='active' AND r.revoked_at IS NULL AND r.last_seen_at>?`,
    )
    .all(now, now, now - RUNNER_SEEN_MS);
  if (!runners.length) return null;
  return {
    total: runners.reduce((total, runner) => total + runner.capacity, 0),
    busy: runners.reduce((busy, runner) => busy + Math.min(runner.used, runner.capacity), 0),
  };
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
    const ahead = (turn: string, best: string) => {
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

export function dispatchReadyItems(db: Database, options: SchedulerOptions = {}): string[] {
  const now = options.now ?? Date.now();
  return immediate(db, () => {
    requeueOrphanedWork(db, now);
    const items = allItems(db, now);
    const byId = new Map(items.map((item) => [item.id, item]));
    const ready = new Set<string>();
    for (const item of items) {
      if (
        item.state !== "queued" ||
        item.cancelRequested ||
        options.canDispatchDelegation?.(item.delegationId) === false
      )
        continue;
      if (item.workspaceId) {
        try {
          for (const id of readyItems(db, { itemId: item.id, workspaceId: item.workspaceId })
            .readyItemIds)
            ready.add(id);
        } catch {
          continue;
        }
      } else if (options.legacyReadyItemIds?.includes(item.id)) ready.add(item.id);
    }
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
    const candidates = items
      .filter((item) => ready.has(item.id))
      .sort(
        (a, b) =>
          (depth.get(b.id) ?? 0) - (depth.get(a.id) ?? 0) ||
          (a.priority || 5) - (b.priority || 5) ||
          a.createdAt - b.createdAt ||
          a.id.localeCompare(b.id),
      );
    const slots = taskSlots(db, now);
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
    const order = fairOrder(
      candidates.filter((item) => !held.some((entry) => entry.itemId === item.id)),
      running,
      cap,
    );
    const admitted: string[] = [];
    for (const { item, capped } of order) {
      if (capped) continue;
      if (free <= 0) break;
      const next = footprint(item, options);
      if (held.some((entry) => byId.get(entry.itemId)?.issueId === item.issueId)) continue;
      db.run(
        `UPDATE job SET status='cancelled',finished_at=? WHERE queue=?
        AND status='pending' AND json_extract(payload,'$.itemId')=?`,
        [now, JOB_KIND.start, item.id],
      );
      const handoff = options.handoffForItem?.(item.id);
      const jobId = enqueueJob(db, {
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
      admitted.push(item.id);
      free -= 1;
    }
    const waiting = order.filter(({ item }) => !admitted.includes(item.id));
    saveQueuePositions(
      db,
      [...waiting.filter(({ capped }) => !capped), ...waiting.filter(({ capped }) => capped)].map(
        ({ item }) => item.id,
      ),
      slots ? { busy: slots.total - Math.max(free, 0), total: slots.total } : null,
      now,
      new Map(waiting.flatMap(({ item, capped }) => (capped && cap ? [[item.id, cap]] : []))),
    );
    return admitted;
  });
}

export function registerScheduler(
  jobs: JobLoop,
  options: () => SchedulerOptions,
  onTick?: () => void,
): () => string[] {
  const dispatch = () => dispatchReadyItems(jobs.db, options());
  jobs.register(TICK, () => {
    if (onTick) onTick();
    else dispatch();
  });
  enqueueJobOnce(jobs.db, {
    queue: TICK,
    jobKey: TICK,
    recurringEveryMs: 30_000,
    now: options().now,
  });
  return dispatch;
}
