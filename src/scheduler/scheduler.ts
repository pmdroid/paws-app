import type { Database } from "bun:sqlite";
import { IN_FLIGHT_ITEM_STATES, JOB_KIND, type RepositoryBinding, type WorkBrief } from "../core";
import { enqueueJob, enqueueJobOnce, immediate, type JobLoop } from "../db";
import { readyItems } from "../intake";

const TICK = "scheduler.tick";
const ACTIVE = new Set<string>(IN_FLIGHT_ITEM_STATES);
type Item = {
  id: string;
  epicId: string;
  issueId: string;
  state: string;
  version: number;
  createdAt: number;
  cancelRequested: number;
  liveRun: number;
  liveJob: number;
  workspaceId: string | null;
  sessionId: string | null;
  priority: number | null;
  owner: string | null;
  repo: string | null;
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
  canDispatchEpic?: (epicId: string) => boolean;
  handoffForItem?: (itemId: string) => string | undefined;
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
    .query<Item, [number]>(`SELECT i.id,i.epic_id AS epicId,i.linear_issue_id AS issueId,
    i.state,i.version,i.created_at AS createdAt,i.cancel_requested AS cancelRequested,
    EXISTS(SELECT 1 FROM run live WHERE live.item_id=i.id AND live.status IN ('active','provisioning')) AS liveRun,
    EXISTS(SELECT 1 FROM job held WHERE json_extract(held.payload,'$.itemId')=i.id
      AND held.status='running' AND (held.locked_until IS NULL OR held.locked_until>?)
      AND (held.queue IN ('item.start','run.resume','run.reverify','github.merge')
        OR held.queue LIKE 'github.merge.%' OR held.lane='merge')) AS liveJob,
    w.id AS workspaceId,s.session_id AS sessionId,c.priority,r.owner,r.repo
    FROM work_item i JOIN epic e ON e.id=i.epic_id
    LEFT JOIN linear_session s ON s.session_id=i.session_key
    LEFT JOIN workspace w ON w.linear_organization_id=s.organization_id
    LEFT JOIN work_item_scheduling c ON c.item_id=i.id
    LEFT JOIN work_item_repository r ON r.item_id=i.id
    WHERE e.state IN ('running','stalled') OR i.state IN ('running','verifying','recovering','awaiting_input','paused','merge_queue')
    OR EXISTS(SELECT 1 FROM run live WHERE live.item_id=i.id AND live.status IN ('active','provisioning'))`)
    .all(now);
}

function holdsExecution(item: Item): boolean {
  return Boolean(
    item.liveRun ||
    item.liveJob ||
    (ACTIVE.has(item.state) && !["merge_queue", "awaiting_input", "paused"].includes(item.state)),
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

function depths(db: Database, items: Item[]): Map<string, number> {
  const ids = new Map<string, string>();
  for (const item of items) {
    const terminal =
      item.state === "completed" || item.state === "merged" || item.state === "cancelled";
    if (terminal && ids.has(item.issueId)) continue;
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
    const items = allItems(db, now);
    const byId = new Map(items.map((item) => [item.id, item]));
    const ready = new Set<string>();
    for (const item of items) {
      if (
        item.state !== "queued" ||
        item.cancelRequested ||
        options.canDispatchEpic?.(item.epicId) === false
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
      if (holdsSession(item) && !held.some((entry) => entry.itemId === item.id))
        held.push(footprint(item, options));
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
    const admitted: string[] = [];
    for (const item of candidates) {
      if (held.some((entry) => entry.itemId === item.id)) continue;
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
    }
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
