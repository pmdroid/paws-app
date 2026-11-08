import { journal, journalCaught } from "../journal";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  JOB_KIND,
  holdsExecution,
  isTerminalWorkItemState,
  type RepositoryBinding,
  type WorkBrief,
} from "../core";
import {
  closeExpiredRunnerLeases,
  enqueueJob,
  enqueueJobOnce,
  enqueueOutboxOnce,
  cancelAdmittedJob,
  cancelPendingItemJobs,
  dropSchedulerAdmission,
  hotFiles,
  immediate,
  itemLinearIdentifier,
  latestItemJobId,
  listBlocksOf,
  listSchedulerAdmissions,
  listTaskBlocks,
  mergeQueueReadyTimes,
  pendingRunnerWaits,
  releaseIdleSessionItem,
  runnerTaskSlots,
  runPendingJobNow,
  saveItemScheduling,
  saveSchedulerAdmission,
  schedulerItems,
  schedulingProjectLead,
  type SchedulerItem,
  latestCandidatePaths,
  requeueOrphanedWork,
  runnerCapacityWait,
  listOverlapHoldAges,
  saveItemHolds,
  saveQueuePositions,
  settled,
  sqliteDb,
  savePinnedSlots,
  RUNNER_FULL,
  type ItemHold,
  type ItemRunnerVerdicts,
  type RunnerHostRefusal,
  type PinnedSlot,
  type JobLoop,
  repositoryKey,
} from "../db";
import { blockingIssues, readyItems } from "../intake";
import { createAdmission, type ItemAdmission } from "./admission";
import { itemWaits, overlapLine, postWaitKeepalives, type ItemWait } from "./waits";

const TICK = JOB_KIND.schedulerTick;
const RUNNER_SEEN_MS = 60_000;
type Item = SchedulerItem;
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
  itemRunners?: (itemId: string) => ItemRunnerVerdicts | null;
  onRunnerHostRefusals?: (refusals: readonly RunnerHostRefusal[], now: number) => void;
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
    return overlapLine(hold.blockers[0]!, hold.files ?? [], hold.start);
  if (hold.reason === "slot" && hold.blockers[0]) return hold.blockers[0];
  return hold.reason === "blocked" && hold.blockers.length
    ? `blocked by ${hold.blockers.join(", ")}`
    : HOLD_LINES[hold.reason];
}

type Overlap = { blocker: string; files: string[]; start?: true };

/**
 * Holds work that would conflict again in the merge queue. A queued item whose latest candidate
 * changes a hot file, one that caused a merge-queue conflict in the last week, waits while a
 * running or merge-queue item in the same repository changes that file too, until that one
 * merges. An item without a candidate is never held: Paws cannot know its files. An item that
 * depends on the candidate, directly or through other issues, never holds it: it cannot merge
 * before the candidate does, so both would wait forever. For the same reason a candidate that
 * keeps its merge-queue place, such as one sent back for a conflict, is held only by an item
 * ahead of it in that queue: anything behind it, or not queued yet, merges after it.
 */
function overlapGate(db: Database, now: number, waiters: readonly Item[]) {
  const hot = new Map<string, Set<string>>();
  for (const file of hotFiles(db, now)) {
    const key = file.repository.toLowerCase();
    hot.set(key, (hot.get(key) ?? new Set()).add(file.path));
  }
  const paths = hot.size ? latestCandidatePaths(db) : new Map<string, string[]>();
  const blocks = new Map<string, string[]>();
  if (hot.size)
    for (const edge of listTaskBlocks(db))
      blocks.set(edge.blocker, [...(blocks.get(edge.blocker) ?? []), edge.blocked]);
  const places = new Map(
    (hot.size ? mergeQueueReadyTimes(db) : []).map((entry) => [entry.itemId, entry.readyAt]),
  );
  const ages = hot.size ? listOverlapHoldAges(db) : new Map<string, number>();
  const waitedLonger = (other: Item, item: Item): boolean => {
    const theirs = ages.get(other.id);
    if (theirs === undefined) return false;
    const mine = ages.get(item.id) ?? Infinity;
    return theirs < mine || (theirs === mine && other.id < item.id);
  };
  /** Whether `other` merges before `item` in the serial lane, by the order the queue uses. */
  const mergesFirst = (other: Item, item: Item): boolean => {
    const mine = places.get(item.id);
    if (mine === undefined) return true;
    const theirs = places.get(other.id);
    return theirs !== undefined && (theirs < mine || (theirs === mine && other.id < item.id));
  };
  /** Every issue that waits for `issueId`, at any depth. */
  const dependents = (issueId: string): Set<string> => {
    const found = new Set<string>();
    const next = [issueId];
    while (next.length)
      for (const blocked of blocks.get(next.pop()!) ?? [])
        if (!found.has(blocked)) {
          found.add(blocked);
          next.push(blocked);
        }
    return found;
  };
  return (item: Item, occupants: readonly Item[]): Overlap | null => {
    if (!item.owner || !item.repo) return null;
    const key = repositoryKey(item.owner, item.repo);
    const files = hot.get(key);
    const mine = files ? (paths.get(item.id) ?? []).filter((path) => files.has(path)) : [];
    if (!mine.length) return null;
    const waiting = dependents(item.issueId);
    const sharedWith = (other: Item): string[] => {
      if (other.id === item.id || !other.owner || !other.repo) return [];
      if (waiting.has(other.issueId) || !mergesFirst(other, item)) return [];
      if (repositoryKey(other.owner, other.repo) !== key) return [];
      const theirs = new Set(paths.get(other.id) ?? []);
      return mine.filter((path) => theirs.has(path));
    };
    for (const other of occupants) {
      const shared = sharedWith(other);
      if (shared.length) return { blocker: other.identifier ?? other.id, files: shared };
    }
    let oldest: { other: Item; files: string[] } | null = null;
    for (const other of waiters) {
      if (!waitedLonger(other, item) || (oldest && !waitedLonger(other, oldest.other))) continue;
      const shared = sharedWith(other);
      if (shared.length) oldest = { other, files: shared };
    }
    return oldest
      ? { blocker: oldest.other.identifier ?? oldest.other.id, files: oldest.files, start: true }
      : null;
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
  saveItemScheduling(db, {
    itemId: input.itemId,
    projectId: input.projectId ?? null,
    projectKnown: Number(input.projectId !== undefined),
    priority,
    paths: paths === null ? null : JSON.stringify(paths),
    projectLeadId: input.projectId === null ? null : (input.projectLeadId ?? null),
    replaceLead: Number(input.projectLeadId !== undefined || input.projectId === null),
  });
}

/** Linear user id of the item's project lead as last saved from Linear, or null. */
export function projectLeadId(db: Database, itemId: string): string | null {
  return schedulingProjectLead(db, itemId);
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

function taskSlots(
  db: Database,
  now: number,
): { total: number; busy: number; open: Map<string, number> } | null {
  const runners = runnerTaskSlots(db, now, now - RUNNER_SEEN_MS);
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

function hostRefusals(verdicts: readonly ItemRunnerVerdicts[]): RunnerHostRefusal[] {
  const runners = new Map<string, { all: boolean; refusals: Map<string, RunnerHostRefusal> }>();
  for (const { repository, agent, runners: answers } of verdicts)
    for (const answer of answers) {
      const entry = runners.get(answer.id) ?? { all: true, refusals: new Map() };
      runners.set(answer.id, entry);
      if (answer.hostConfig === null || repository === null) {
        entry.all = false;
        continue;
      }
      entry.refusals.set(`${repository}:${answer.hostConfig}`, {
        runnerId: answer.id,
        runnerName: answer.name,
        repository,
        kind: answer.hostConfig,
        agent,
      });
    }
  return [...runners.values()].flatMap((entry) => (entry.all ? [...entry.refusals.values()] : []));
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
  return pendingRunnerWaits(db, now - RUNNER_SEEN_MS).flatMap(
    ({ payload, runnerId, online, merging, ...wait }): PinnedWait[] => {
      const capacity = runnerCapacityWait(JSON.parse(payload));
      if (!capacity || now - capacity.since >= (capacity.holdMs ?? Infinity)) return [];
      const pinned = online && runnerId !== null && capacity.runnerIds.includes(runnerId);
      if (pinned && (!merging || capacity.runnerIds.length === 1))
        return [{ ...wait, runnerIds: [runnerId] }];
      return merging && capacity.runnerIds.length
        ? [{ ...wait, runnerIds: capacity.runnerIds }]
        : [];
    },
  );
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
  const edges = listTaskBlocks(db);
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
    releaseIdleSessionItem(db, item.id, now);
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
    if (
      !listBlocksOf(
        db,
        members.map((member) => member.issueId),
      ).length
    )
      continue;
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
    closeExpiredRunnerLeases(db, now);
    requeueOrphanedWork(db, now);
    const items = schedulerItems(db, now);
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
    const saved = listSchedulerAdmissions(db);
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
      cancelAdmittedJob(db, row.jobId, now);
      dropSchedulerAdmission(db, row.itemId);
    }
    for (const item of items)
      if (holdsSession(item) && !held.some((entry) => entry.itemId === item.id)) {
        const entry = footprint(item, options);
        const jobId = latestItemJobId(
          db,
          item.id,
          [JOB_KIND.start, JOB_KIND.resume, JOB_KIND.reverify],
          ["pending", "running"],
        );
        if (jobId !== null)
          saveSchedulerAdmission(
            db,
            {
              itemId: item.id,
              jobId,
              repositoryKey: entry.repositoryKey,
              sessionId: entry.sessionId,
              now,
            },
            true,
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
    const answers = new Map<string, ItemRunnerVerdicts | null>();
    const verdictsFor = (itemId: string): ItemRunnerVerdicts | null => {
      if (!options.itemRunners) return null;
      if (!answers.has(itemId)) answers.set(itemId, options.itemRunners(itemId));
      return answers.get(itemId)!;
    };
    const openRunner = (itemId: string): string | null | undefined => {
      const verdicts = verdictsFor(itemId);
      if (!verdicts) return undefined;
      const open = (id: string) => slots?.open.get(id) ?? 0;
      const free = verdicts.runners.filter(
        (runner) => runner.rejection === null && open(runner.id) > 0,
      );
      return free[0]?.id ?? null;
    };
    const takeSlot = (itemId: string): boolean => {
      const runnerId = openRunner(itemId);
      if (runnerId === undefined) return true;
      if (runnerId === null) return false;
      for (const runner of verdictsFor(itemId)!.runners)
        if (runner.rejection === null)
          slots!.open.set(runner.id, (slots!.open.get(runner.id) ?? 0) - 1);
      return true;
    };
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
        runPendingJobNow(db, pin.jobId, now);
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
    for (const item of items)
      if (
        !item.placed &&
        (item.placing ||
          (item.state === "queued" && held.some((entry) => entry.itemId === item.id)))
      )
        takeSlot(item.id);
    const running = new Map<string, number>();
    for (const item of items)
      if (
        holdsExecution(item) ||
        (item.state === "queued" && held.some((entry) => entry.itemId === item.id))
      )
        running.set(item.turn, (running.get(item.turn) ?? 0) + 1);
    const cap = options.ownerCap ?? null;
    const overlapping = overlapGate(
      db,
      now,
      candidates.filter(
        (item) =>
          !held.some((entry) => entry.itemId === item.id) &&
          (slots === null || options.ownerHasRunner?.(item.id) !== false),
      ),
    );
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
      if (!takeSlot(item.id)) continue;
      cancelPendingItemJobs(db, JOB_KIND.start, item.id, now);
      const handoff = options.handoffForItem?.(item.id);
      const jobId =
        latestItemJobId(db, item.id, ["run.resume"], ["pending"]) ??
        enqueueJob(db, {
          queue: JOB_KIND.start,
          payload: { itemId: item.id, ...(handoff ? { handoff } : {}) },
          now,
        });
      saveSchedulerAdmission(db, {
        itemId: item.id,
        jobId,
        repositoryKey: next.repositoryKey,
        sessionId: next.sessionId,
        now,
      });
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
    const noRunnerLine = (itemId: string): string | null => {
      if (openRunner(itemId) !== null) return null;
      const verdicts = verdictsFor(itemId)!;
      if (!verdicts.runners.length)
        return `No runner can take ${verdicts.repository ?? "this item"}: no paired runners available to its owner`;
      return `No runner can take ${verdicts.repository ?? "this item"}: ${verdicts.runners
        .map((runner) => `${runner.name}: ${runner.rejection ?? RUNNER_FULL}`)
        .join("; ")}`;
    };
    const line = [
      ...waiting.filter(({ capped }) => !capped),
      ...waiting.filter(({ capped }) => capped),
    ].map(({ item }) => item.id);
    settled(
      saveQueuePositions(
        sqliteDb(db),
        line,
        slots ? { busy: slots.total - Math.max(free, 0), total: slots.total } : null,
        now,
        new Map(waiting.flatMap(({ item, capped }) => (capped && cap ? [[item.id, cap]] : []))),
      ),
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
      ...waiting.map(({ item, capped }): ItemHold => {
        const noRunner = capped ? null : noRunnerLine(item.id);
        return {
          itemId: item.id,
          reason: capped ? "cap" : "slot",
          blockers: noRunner === null ? [] : [noRunner],
        };
      }),
      ...[...overlaps].map(([itemId, overlap]): ItemHold => ({
        itemId,
        reason: "overlap",
        blockers: [overlap.blocker],
        files: overlap.files,
        ...(overlap.start ? { start: overlap.start } : {}),
      })),
    ];
    const changes = saveItemHolds(db, holds, now).map((change) => {
      const name =
        byId.get(change.itemId)?.identifier ??
        itemLinearIdentifier(db, change.itemId) ??
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
      hostRefusals: hostRefusals(
        order.flatMap(({ item }) => {
          const verdicts = verdictsFor(item.id);
          return verdicts ? [verdicts] : [];
        }),
      ),
    };
  });
  if (options.log) for (const line of result.changes) options.log(line);
  options.onWaiting?.(result.waiting);
  options.onRunnerSetup?.(result.setup);
  options.onWaits?.(result.waits);
  options.onRunnerHostRefusals?.(result.hostRefusals, now);
  return result.admitted;
}

export function registerScheduler(jobs: JobLoop, tick: () => void, now = Date.now()): void {
  jobs.register(TICK, tick);
  enqueueJobOnce(jobs.db, { queue: TICK, jobKey: TICK, recurringEveryMs: 30_000, now });
}
