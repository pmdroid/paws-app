import type { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { removeWorktree, worktreeMergedInto, worktreePath } from "../acp";
import type { RepositoryBinding, WorkItemState } from "../core";
import { listWorkItems, type WorkItemRecord } from "../db";
import { itemPathId } from "./sources";

export const RETIRED_WORKTREE_MS = 7 * 24 * 60 * 60 * 1000;

const RETIRED_STATES: ReadonlySet<WorkItemState> = new Set([
  "merged",
  "completed",
  "cancelled",
  "failed",
]);

const IDLE_STATES: ReadonlySet<WorkItemState> = new Set([
  ...RETIRED_STATES,
  "paused",
  "awaiting_input",
  "manual",
]);

export type WorktreeSweep = {
  db: Database;
  pawsRoot: string;
  now: number;
  signal: AbortSignal;
  repositoryForItem(item: WorkItemRecord): RepositoryBinding | null;
  busy(itemId: string): boolean;
  hold(itemIds: readonly string[], operation: () => Promise<void>): Promise<void>;
  mergedHeads(item: WorkItemRecord, repository: RepositoryBinding): Promise<string[]>;
};

export async function sweepWorktrees(sweep: WorktreeSweep): Promise<void> {
  for (const [pathId, items] of owners(sweep.db)) {
    sweep.signal.throwIfAborted();
    const path = worktreePath(sweep.pawsRoot, pathId);
    const repository = sweep.repositoryForItem(items[0]!);
    const touched = lastTouched(sweep.db, items, path);
    if (!repository || touched === null || !items.every(idle)) continue;
    if (items.some((item) => sweep.busy(item.id))) continue;
    const expired =
      items.every((item) => RETIRED_STATES.has(item.state)) &&
      touched <= sweep.now - RETIRED_WORKTREE_MS;
    const heads = expired ? [] : await mergedHeads(sweep, items[0]!, repository);
    if (!expired && !(await worktreeMergedInto(path, heads))) continue;
    const ids = items.map((item) => item.id);
    await sweep.hold(ids, async () => {
      const current = owners(sweep.db).get(pathId) ?? [];
      const unchanged =
        current.length === items.length &&
        current.every(
          (item) => items.find((before) => before.id === item.id)?.state === item.state,
        );
      if (!unchanged || (!expired && !(await worktreeMergedInto(path, heads)))) return;
      await removeWorktree({ ...repository, itemId: pathId, pawsRoot: sweep.pawsRoot }).catch(
        () => undefined,
      );
    });
  }
}

function owners(db: Database): Map<string, WorkItemRecord[]> {
  const byPath = new Map<string, WorkItemRecord[]>();
  for (const item of listWorkItems(db)) {
    const pathId = itemPathId(item);
    byPath.set(pathId, [...(byPath.get(pathId) ?? []), item]);
  }
  return byPath;
}

function idle(item: WorkItemRecord): boolean {
  return IDLE_STATES.has(item.state);
}

function lastTouched(db: Database, items: WorkItemRecord[], path: string): number | null {
  let modified: number;
  try {
    modified = statSync(path).mtimeMs;
  } catch {
    return null;
  }
  const ran = db
    .query<{ at: number | null }, string[]>(
      `SELECT MAX(updated_at) AS at FROM run WHERE item_id IN (${items.map(() => "?").join(",")})`,
    )
    .get(...items.map((item) => item.id));
  return Math.max(modified, ran?.at ?? 0);
}

async function mergedHeads(
  sweep: WorktreeSweep,
  item: WorkItemRecord,
  repository: RepositoryBinding,
): Promise<string[]> {
  try {
    return await sweep.mergedHeads(item, repository);
  } catch {
    return [];
  }
}
