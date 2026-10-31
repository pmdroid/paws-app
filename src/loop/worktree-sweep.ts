import { journal, journalCaught } from "../journal";
import type { Database } from "bun:sqlite";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { removeWorktree, worktreePath } from "../acp";
import type { RepositoryBinding, WorkItemState } from "../core";
import { listWorkItems, type WorkItemRecord } from "../db";
import { itemPathId } from "./sources";

export const RETIRED_WORKTREE_MS = 7 * 24 * 60 * 60 * 1000;
const RETIRED_STATES: ReadonlySet<WorkItemState> = new Set(["merged", "cancelled", "failed"]);
const missingOwnerNotices = new Set<string>();

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
  const root = join(sweep.pawsRoot, "worktrees");
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      journalCaught(error, "worktree-sweep.readdir", null);
    return;
  }
  const byPath = owners(sweep.db);
  for (const entry of entries) {
    sweep.signal.throwIfAborted();
    if (!entry.isDirectory()) continue;
    const items = byPath.get(entry.name);
    if (!items?.length) {
      const path = join(root, entry.name);
      if (!missingOwnerNotices.has(path)) {
        missingOwnerNotices.add(path);
        journal(
          JSON.stringify({
            level: "info",
            event: "worktree-sweep.skipped",
            path,
            reason: "owner_missing",
          }),
        );
      }
      continue;
    }
    if (!items.every((item) => RETIRED_STATES.has(item.state))) continue;
    if (items.some((item) => sweep.busy(item.id))) continue;
    try {
      const path = worktreePath(sweep.pawsRoot, entry.name);
      if (!expired(sweep, items, path)) continue;
      const repository = sweep.repositoryForItem(items[0]!);
      if (!repository) continue;
      await sweep.hold(
        items.map((item) => item.id),
        async () => {
          await removeWorktree(
            { ...repository, itemId: entry.name, pawsRoot: sweep.pawsRoot },
            () => {
              sweep.signal.throwIfAborted();
              const current = owners(sweep.db).get(entry.name) ?? [];
              return (
                current.length === items.length &&
                current.every((item) => {
                  const before = items.find((candidate) => candidate.id === item.id);
                  return before?.state === item.state && before.version === item.version;
                }) &&
                expired(sweep, current, path)
              );
            },
          );
        },
      );
    } catch (error) {
      sweep.signal.throwIfAborted();
      journalCaught(error, "worktree-sweep.remove", items[0]!.id);
    }
  }
}

function owners(db: Database): Map<string, WorkItemRecord[]> {
  const byPath = new Map<string, WorkItemRecord[]>();
  for (const item of listWorkItems(db)) {
    const key = itemPathId(item);
    const items = byPath.get(key) ?? [];
    items.push(item);
    byPath.set(key, items);
  }
  return byPath;
}

function expired(sweep: WorktreeSweep, items: WorkItemRecord[], path: string): boolean {
  if (!items.length || !items.every((item) => RETIRED_STATES.has(item.state))) return false;
  const placeholders = items.map(() => "?").join(",");
  const ids = items.map((item) => item.id);
  const activity = sweep.db
    .query<{ at: number | null }, string[]>(`
    SELECT MAX(at) AS at FROM (
      SELECT MAX(updated_at) AS at FROM run WHERE item_id IN (${placeholders})
      UNION ALL
      SELECT MAX(event.at) AS at FROM work_item_event event
      JOIN work_item item ON item.id = event.item_id
      WHERE event.item_id IN (${placeholders}) AND event.to_state = item.state
    )`)
    .get(...ids, ...ids);
  return Math.max(statSync(path).mtimeMs, activity?.at ?? 0) <= sweep.now - RETIRED_WORKTREE_MS;
}
