import { journalCaught } from "../journal";
import type { Database } from "bun:sqlite";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { git, removeWorktree, worktreeMergedInto, worktreePath } from "../acp";
import type { RepositoryBinding, WorkItemState } from "../core";
import { getWorkItem, listWorkItems, type WorkItemRecord } from "../db";
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
  for (const [pathId, items] of owners(sweep.db))
    for (const item of items) recordWorktreeOwner(sweep.pawsRoot, pathId, item.id);
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

export function recordWorktreeOwner(pawsRoot: string, pathId: string, itemId: string): void {
  worktreePath(pawsRoot, itemId);
  try {
    const gitDir = worktreeGitDirectory(worktreePath(pawsRoot, pathId));
    const directory = join(gitDir, "paws-item-owners");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, itemId), "", { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (!["ENOENT", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}

function worktreeGitDirectory(path: string): string {
  const link = readFileSync(join(path, ".git"), "utf8").trim();
  if (!link.startsWith("gitdir: ")) throw new Error("Expected a linked Git worktree");
  return realpathSync(resolve(path, link.slice(8)));
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
    try {
      const gitDir = worktreeGitDirectory(path);
      const mirror = realpathSync(resolve(gitDir, "../.."));
      const repos = realpathSync(join(sweep.pawsRoot, "repos"));
      const rel = relative(repos, mirror);
      if (
        !rel ||
        rel.startsWith("..") ||
        isAbsolute(rel) ||
        dirname(gitDir) !== join(mirror, "worktrees")
      )
        continue;
      const ids = readdirSync(join(gitDir, "paws-item-owners"));
      if (!ids.length || ids.some((id) => getWorkItem(sweep.db, id) || sweep.busy(id))) continue;
      await sweep.hold(ids, async () => {
        if (owners(sweep.db).has(entry.name) || ids.some((id) => getWorkItem(sweep.db, id))) return;
        const status = await git(["-C", path, "status", "--porcelain"]);
        if (status.trim()) return;
        await git(["--git-dir", mirror, "worktree", "remove", path]);
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        journalCaught(error, "worktree-sweep.sweepOrphans.remove", entry.name);
    }
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
