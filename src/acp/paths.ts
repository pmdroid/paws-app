import { homedir } from "node:os";
import { join } from "node:path";

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

export function assertSafeSegment(value: string, label: string): void {
  if (!SAFE_SEGMENT.test(value)) {
    throw new Error(`${label} must be a single path segment of letters, numbers, '.', '_' or '-'`);
  }
}

/** `~/.paws`, or `PAWS_HOME` when a process is pointed at another root. */
export function pawsRootFrom(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const configured = env.PAWS_HOME?.trim();
  if (configured) return configured;
  return join(home, ".paws");
}

export function mirrorPath(root: string, owner: string, repo: string): string {
  assertSafeSegment(owner, "owner");
  assertSafeSegment(repo, "repo");
  return join(root, "repos", owner, `${repo}.git`);
}

export function worktreePath(root: string, itemId: string): string {
  assertSafeSegment(itemId, "item id");
  return join(root, "worktrees", itemId);
}

/** `paws/eng-n` — the item id is lowercased, the worktree directory is not. */
export function branchName(itemId: string): string {
  assertSafeSegment(itemId, "item id");
  return `paws/${itemId.toLowerCase()}`;
}

export function runDir(root: string, runId: string): string {
  assertSafeSegment(runId, "run id");
  return join(root, "runs", runId);
}
