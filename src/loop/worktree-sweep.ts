import { journalCaught } from "../journal";
import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { git, removeWorktree, worktreeMergedInto, worktreePath } from "../acp";
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
  await sweepOrphans(sweep);
  for (const [pathId, items] of owners(sweep.db)) {
    sweep.signal.throwIfAborted();
    const path = worktreePath(sweep.pawsRoot, pathId);
    const repository = sweep.repositoryForItem(items[0]!);
    const touched = lastTouched(sweep.db, items, path);
    if (!repository || touched === null || !items.every(idle)) continue;
    if (items.some((item) => sweep.busy(item.id))) continue;
    const terminalAt = items.map(
      (item) =>
        sweep.db
          .query<{ at: number }, [string, string]>(
            "SELECT at FROM work_item_event WHERE item_id = ? AND to_state = ? ORDER BY version DESC LIMIT 1",
          )
          .get(item.id, item.state)?.at,
    );
    const expired =
      items.every((item) => RETIRED_STATES.has(item.state)) &&
      Math.max(touched, ...terminalAt.map((at) => at ?? 0)) <= sweep.now - RETIRED_WORKTREE_MS;
    if (!expired && items.some((item) => item.state === "cancelled")) continue;
    const heads = expired ? [] : await mergedHeads(sweep, items[0]!, repository);
    if (!expired && !(await worktreeMergedInto(path, heads))) continue;
    const ids = items.map((item) => item.id);
    await sweep.hold(ids, async () => {
      const current = owners(sweep.db).get(pathId) ?? [];
      const unchanged =
        current.length === items.length &&
        current.every((item) => {
          const before = items.find((candidate) => candidate.id === item.id);
          return before?.state === item.state && before.version === item.version;
        });
      if (!unchanged || (!expired && !(await worktreeMergedInto(path, heads)))) return;
      await removeWorktree({ ...repository, itemId: pathId, pawsRoot: sweep.pawsRoot }).catch(
        (caughtError1) => {
          journalCaught(
            caughtError1,
            "worktree-sweep.sweepWorktrees.removeWorktree",
            items.map((item) => item.id).join(","),
          );
          return undefined;
        },
      );
    });
  }
}

async function sweepOrphans(sweep: WorktreeSweep): Promise<void> {
  const root = join(sweep.pawsRoot, "worktrees");
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      journalCaught(error, "worktree-sweep.sweepOrphans.readdir", null);
    return;
  }
  for (const entry of entries) {
    sweep.signal.throwIfAborted();
    if (!entry.isDirectory() || owners(sweep.db).has(entry.name)) continue;
    const path = join(root, entry.name);
    await sweep.hold([], async () => {
      if (owners(sweep.db).has(entry.name)) return;
      try {
        const link = readFileSync(join(path, ".git"), "utf8").trim();
        if (!link.startsWith("gitdir: ")) return;
        const gitDir = realpathSync(resolve(path, link.slice(8)));
        const mirror = realpathSync(resolve(gitDir, "../.."));
        const repos = realpathSync(join(sweep.pawsRoot, "repos"));
        const rel = relative(repos, mirror);
        if (
          !rel ||
          rel.startsWith("..") ||
          isAbsolute(rel) ||
          dirname(gitDir) !== join(mirror, "worktrees")
        )
          return;
        await git(["--git-dir", mirror, "worktree", "remove", "--force", path]);
      } catch (error) {
        journalCaught(error, "worktree-sweep.sweepOrphans.remove", entry.name);
      }
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
  } catch (caughtError2) {
    journalCaught(
      caughtError2,
      "worktree-sweep.lastTouched.statSync",
      items.map((item) => item.id).join(","),
      "optional file may be absent",
    );
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
  } catch (caughtError3) {
    journalCaught(caughtError3, "worktree-sweep.mergedHeads", item?.id);
    return [];
  }
}
