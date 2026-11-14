import { mkdir } from "node:fs/promises";
import { branchName, mirrorPath, worktreePath } from "./paths";
import {
  createItemCheckout,
  createWorktree,
  ensureBareMirror,
  ensureCandidateRef,
} from "./worktree";
import { runAgent } from "./run";
import type { ExecuteItemOptions, ExecuteItemResult } from "./types";

/**
 * Prepare the bare mirror and the item worktree, then run the implementer
 * (or a reviewer, when `role` is set) inside that worktree. A runner-backed
 * item gets its candidate ref in the mirror instead of a worktree.
 * Push, pull requests, and merge stay in the GitHub module.
 */
export async function executeItem({
  storedCandidate,
  ...options
}: ExecuteItemOptions): Promise<ExecuteItemResult> {
  const stored = storedCandidate === true && options.workspace !== undefined;
  const mirror =
    stored || options.mirrors === false
      ? {
          path:
            options.mirrors === false
              ? worktreePath(options.pawsRoot, options.itemId)
              : mirrorPath(options.pawsRoot, options.owner, options.repo),
        }
      : await ensureBareMirror({
          remoteUrl: options.remoteUrl,
          owner: options.owner,
          repo: options.repo,
          pawsRoot: options.pawsRoot,
          ...(options.networkGit ? { networkGit: options.networkGit } : {}),
        });
  const placement = {
    owner: options.owner,
    repo: options.repo,
    itemId: options.itemId,
    pawsRoot: options.pawsRoot,
    ...(options.startRef ? { startRef: options.startRef } : {}),
  };
  let worktree: { path: string; branch: string };
  if (options.workspace !== undefined) {
    if (!stored) await ensureCandidateRef(placement);
    await mkdir(options.workspace, { recursive: true, mode: 0o700 });
    worktree = { path: options.workspace, branch: branchName(options.itemId) };
  } else
    worktree =
      options.mirrors === false
        ? await createItemCheckout(options)
        : await createWorktree({
            ...placement,
            ...(options.checkoutExclusions
              ? { checkoutExclusions: options.checkoutExclusions }
              : {}),
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
