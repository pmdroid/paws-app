import { createWorktree, ensureBareMirror } from "./worktree";
import { runAgent } from "./run";
import type { ExecuteItemOptions, ExecuteItemResult } from "./types";

/**
 * Prepare the bare mirror and the item worktree, then run the implementer
 * (or a reviewer, when `role` is set) inside that worktree.
 * Push, pull requests, and merge stay in the GitHub module.
 */
export async function executeItem(options: ExecuteItemOptions): Promise<ExecuteItemResult> {
  const mirror = await ensureBareMirror({
    remoteUrl: options.remoteUrl,
    owner: options.owner,
    repo: options.repo,
    pawsRoot: options.pawsRoot,
    ...(options.networkGit ? { networkGit: options.networkGit } : {}),
  });
  const worktree = await createWorktree({
    owner: options.owner,
    repo: options.repo,
    itemId: options.itemId,
    pawsRoot: options.pawsRoot,
    ...(options.startRef ? { startRef: options.startRef } : {}),
  });
  const run = await (options.promptRunner ?? runAgent)({
    ...options,
    role: options.role ?? "implementer",
    repository: `${options.owner}/${options.repo}`,
    worktreePath: worktree.path,
  });
  return {
    mirrorPath: mirror.path,
    worktreePath: worktree.path,
    branch: worktree.branch,
    run,
  };
}
