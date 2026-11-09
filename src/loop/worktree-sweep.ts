import { journalCaught } from "../journal";
import { statSync } from "node:fs";
import {
  adoptLegacyCandidate,
  git,
  removeWorktree,
  worktreeMergedInto,
  worktreePath,
} from "../acp";
import type { RepositoryBinding, WorkItemState } from "../core";
import { latestRunUpdateSteps, listWorkItemsSteps, type Db, type WorkItemRecord } from "../db";
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
  store: Db;
  pawsRoot: string;
  now: number;
  signal: AbortSignal;
  /**
   * Items run on remote runners, so the control plane keeps no worktree for them: a worktree an
   * earlier release left goes as soon as no work on its items runs in this process.
   */
  runnerBacked?: boolean;
  repositoryForItem(item: WorkItemRecord): RepositoryBinding | null;
  busy(itemId: string): boolean;
  hold(itemIds: readonly string[], operation: () => Promise<void>): Promise<void>;
  mergedHeads(item: WorkItemRecord, repository: RepositoryBinding): Promise<string[]>;
};

export async function sweepWorktrees(sweep: WorktreeSweep): Promise<void> {
  for (const [pathId, items] of await owners(sweep.store)) {
    sweep.signal.throwIfAborted();
    const path = worktreePath(sweep.pawsRoot, pathId);
    const repository = sweep.repositoryForItem(items[0]!);
    const touched = await lastTouched(sweep.store, items, path);
    const leftover = sweep.runnerBacked === true;
    if (!repository || touched === null || (!leftover && !items.every(idle))) continue;
    if (items.some((item) => sweep.busy(item.id))) continue;
    const expired =
      leftover ||
      (items.every((item) => RETIRED_STATES.has(item.state)) &&
        touched <= sweep.now - RETIRED_WORKTREE_MS);
    const heads = expired ? [] : await mergedHeads(sweep, items[0]!, repository);
    if (!expired && !(await worktreeMergedInto(path, heads))) continue;
    const ids = items.map((item) => item.id);
    await sweep.hold(ids, async () => {
      const current = (await owners(sweep.store)).get(pathId) ?? [];
      const unchanged =
        current.length === items.length &&
        current.every(
          (item) => items.find((before) => before.id === item.id)?.state === item.state,
        );
      if (!unchanged || (!expired && !(await worktreeMergedInto(path, heads)))) return;
      if (leftover && !(await keepLeftoverHead(sweep, repository, pathId, path))) return;
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

async function keepLeftoverHead(
  sweep: WorktreeSweep,
  repository: RepositoryBinding,
  pathId: string,
  path: string,
): Promise<boolean> {
  try {
    const worktreeHead = (await git(["-C", path, "rev-parse", "--verify", "HEAD"])).trim();
    await adoptLegacyCandidate({
      ...repository,
      itemId: pathId,
      pawsRoot: sweep.pawsRoot,
      worktreeHead,
    });
    return true;
  } catch (caughtError4) {
    journalCaught(caughtError4, "worktree-sweep.keepLeftoverHead", pathId);
    return false;
  }
}

async function owners(store: Db): Promise<Map<string, WorkItemRecord[]>> {
  const byPath = new Map<string, WorkItemRecord[]>();
  for (const item of await store.run(listWorkItemsSteps)) {
    const pathId = itemPathId(item);
    byPath.set(pathId, [...(byPath.get(pathId) ?? []), item]);
  }
  return byPath;
}

function idle(item: WorkItemRecord): boolean {
  return IDLE_STATES.has(item.state);
}

async function lastTouched(
  store: Db,
  items: WorkItemRecord[],
  path: string,
): Promise<number | null> {
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
  const ids = items.map((item) => item.id);
  return Math.max(modified, (await store.run((q) => latestRunUpdateSteps(q, ids))) ?? 0);
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
