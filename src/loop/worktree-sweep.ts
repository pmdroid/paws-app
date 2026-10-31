import { journalCaught } from "../journal";
import type { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { assertSafeSegment, git, worktreeMergedInto, worktreePath } from "../acp";
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
const pathOperations = new Map<string, Promise<void>>();

export async function withWorktreePath<T>(
  pawsRoot: string,
  pathId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const path = worktreePath(pawsRoot, pathId);
  const previous = pathOperations.get(path) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((done) => {
    release = done;
  });
  pathOperations.set(path, next);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (pathOperations.get(path) === next) pathOperations.delete(path);
  }
}

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
  const index = ownerIndex(sweep.db);
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    sweep.signal.throwIfAborted();
    if (!entry.isDirectory()) continue;
    try {
      await withWorktreePath(sweep.pawsRoot, entry.name, async () => {
        sweep.signal.throwIfAborted();
        const path = worktreePath(sweep.pawsRoot, entry.name);
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
          return;
        const recorded = recordedOwners(gitDir);
        const items = pathOwners(index, entry.name, recorded);
        for (const item of items) recordOwner(gitDir, item.id);
        const ids = [...new Set([...recorded, ...items.map((item) => item.id)])];
        if (!ids.length) {
          journalCaught(
            new Error("Retained worktree without identifiable item ownership"),
            "worktree-sweep.unidentified",
            entry.name,
          );
          return;
        }
        await sweepPath(sweep, entry.name, path, mirror, ids, items);
      });
    } catch (error) {
      sweep.signal.throwIfAborted();
      journalCaught(error, "worktree-sweep.path", entry.name);
    }
  }
}

async function sweepPath(
  sweep: WorktreeSweep,
  pathId: string,
  path: string,
  mirror: string,
  ids: string[],
  items: WorkItemRecord[],
): Promise<void> {
  if (ids.some((id) => sweep.busy(id)) || !items.every((item) => IDLE_STATES.has(item.state)))
    return;
  const touched = items.length ? lastTouched(sweep.db, items, path) : null;
  const expired =
    items.length > 0 &&
    touched !== null &&
    items.every((item) => RETIRED_STATES.has(item.state)) &&
    touched <= sweep.now - RETIRED_WORKTREE_MS;
  if (!expired && items.some((item) => item.state === "cancelled")) return;
  const repository = items.length ? sweep.repositoryForItem(items[0]!) : null;
  const heads = !expired && repository ? await mergedHeads(sweep, items[0]!, repository) : [];
  if (items.length && !expired && !(await worktreeMergedInto(path, heads))) return;
  await sweep.hold(ids, async () => {
    const unchanged = () => {
      const current = pathOwners(ownerIndex(sweep.db), pathId, ids);
      return (
        current.length === items.length &&
        current.every((item) => {
          const before = items.find((candidate) => candidate.id === item.id);
          return before?.state === item.state && before.version === item.version;
        })
      );
    };
    if (!unchanged()) return;
    if (!expired) {
      if (items.length) {
        if (!(await worktreeMergedInto(path, heads))) return;
      } else if ((await git(["-C", path, "status", "--porcelain"])).trim()) return;
    }
    sweep.signal.throwIfAborted();
    if (!unchanged()) return;
    await git(["--git-dir", mirror, "worktree", "remove", ...(expired ? ["--force"] : []), path]);
  });
}

export function recordWorktreeOwner(pawsRoot: string, pathId: string, itemId: string): void {
  try {
    recordOwner(worktreeGitDirectory(worktreePath(pawsRoot, pathId)), itemId);
  } catch (error) {
    journalCaught(error, "worktree-sweep.recordWorktreeOwner", itemId);
  }
}

function recordOwner(gitDir: string, itemId: string): void {
  try {
    assertSafeSegment(itemId, "worktree owner");
    const directory = join(gitDir, "paws-item-owners");
    const marker = join(directory, itemId);
    if (existsSync(marker)) return;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(marker, "", { mode: 0o600, flag: "wx" });
  } catch (error) {
    journalCaught(error, "worktree-sweep.recordOwner", itemId);
  }
}

function recordedOwners(gitDir: string): string[] {
  try {
    return readdirSync(join(gitDir, "paws-item-owners"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return [];
  }
}

function worktreeGitDirectory(path: string): string {
  const link = readFileSync(join(path, ".git"), "utf8").trim();
  if (!link.startsWith("gitdir: ")) throw new Error("Expected a linked Git worktree");
  return realpathSync(resolve(path, link.slice(8)));
}

function ownerIndex(db: Database) {
  const byPath = new Map<string, WorkItemRecord[]>();
  const byId = new Map<string, WorkItemRecord>();
  for (const item of listWorkItems(db)) {
    byId.set(item.id, item);
    const keys = new Set([
      itemPathId(item).toLowerCase(),
      item.branchName.replace(/^paws\//, "").toLowerCase(),
    ]);
    for (const key of keys) {
      const items = byPath.get(key) ?? [];
      items.push(item);
      byPath.set(key, items);
    }
  }
  return { byPath, byId };
}

function pathOwners(
  index: ReturnType<typeof ownerIndex>,
  pathId: string,
  recorded: string[],
): WorkItemRecord[] {
  const items = new Map(
    (index.byPath.get(pathId.toLowerCase()) ?? []).map((item) => [item.id, item]),
  );
  const suffix = pathId.match(/-([0-9A-HJKMNP-TV-Z]{26})$/i)?.[1];
  for (const id of [...recorded, ...(suffix ? [suffix] : [])]) {
    const item = index.byId.get(id);
    if (item) items.set(id, item);
  }
  return [...items.values()];
}

function lastTouched(db: Database, items: WorkItemRecord[], path: string): number {
  const placeholders = items.map(() => "?").join(",");
  const ids = items.map((item) => item.id);
  const activity = db
    .query<{ at: number | null }, string[]>(`
    SELECT MAX(at) AS at FROM (
      SELECT MAX(updated_at) AS at FROM run WHERE item_id IN (${placeholders})
      UNION ALL
      SELECT MAX(event.at) AS at FROM work_item_event event
      JOIN work_item item ON item.id = event.item_id
      WHERE event.item_id IN (${placeholders}) AND event.to_state = item.state
    )`)
    .get(...ids, ...ids);
  return Math.max(statSync(path).mtimeMs, activity?.at ?? 0);
}

async function mergedHeads(
  sweep: WorktreeSweep,
  item: WorkItemRecord,
  repository: RepositoryBinding,
): Promise<string[]> {
  try {
    return await sweep.mergedHeads(item, repository);
  } catch (error) {
    journalCaught(error, "worktree-sweep.mergedHeads", item.id);
    return [];
  }
}
