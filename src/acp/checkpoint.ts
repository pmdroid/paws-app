import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { git } from "./git";
import { mirrorPath, worktreePath } from "./paths";

export interface CheckpointResult {
  committed: boolean;
  sha?: string;
  message: string;
}

export interface FreshMainCheckout {
  restarted: boolean;
  wipBranch: string;
  wipSha?: string;
  worktreePath: string;
  startRef?: string;
  branch?: string;
  reason?: string;
}

const COMMIT_ENV_DEFAULTS = {
  GIT_AUTHOR_NAME: "Paws",
  GIT_AUTHOR_EMAIL: "paws@localhost",
  GIT_COMMITTER_NAME: "Paws",
  GIT_COMMITTER_EMAIL: "paws@localhost",
};

/** Same order as worktree start refs: a published main, then whatever the mirror has. */
const START_REFS = ["origin/main", "main", "origin/master", "HEAD"] as const;

/**
 * Commit whatever is dirty in the item worktree. A clean tree is left as it is.
 * Hooks are skipped so a cancel or timeout still records the checkpoint.
 */
export async function commitCheckpoint(
  tree: string,
  message = "wip: checkpoint",
): Promise<CheckpointResult> {
  const status = (await git(["-C", tree, "status", "--porcelain"])).trim();
  if (!status) return { committed: false, message };

  await git(["-C", tree, "add", "-A"]);
  const env = { ...process.env, ...COMMIT_ENV_DEFAULTS };
  await git(commitArgs(tree, message), { env });
  const sha = (await git(["-C", tree, "rev-parse", "HEAD"])).trim();
  return { committed: true, sha, message };
}

/**
 * Same commit as `commitCheckpoint`, run synchronously so SIGTERM can finish
 * it before exit. A missing worktree records nothing.
 */
export function commitCheckpointSync(tree: string, message = "wip: shutdown"): CheckpointResult {
  if (!existsSync(tree)) return { committed: false, message };
  let status: string;
  try {
    status = gitSync(["-C", tree, "status", "--porcelain"]).trim();
  } catch {
    return { committed: false, message };
  }
  if (!status) return { committed: false, message };
  gitSync(["-C", tree, "add", "-A"]);
  gitSync(commitArgs(tree, message), { ...process.env, ...COMMIT_ENV_DEFAULTS });
  const sha = gitSync(["-C", tree, "rev-parse", "HEAD"]).trim();
  return { committed: true, sha, message };
}

/**
 * Commit dirty files onto the WIP branch, then check `origin/main` out into a
 * new worktree at the item path. The WIP branch stays in the mirror for reference.
 * The next run reuses that path, so it starts from fresh main.
 */
export function restartFromFreshMain(options: {
  pawsRoot: string;
  owner: string;
  repo: string;
  itemId: string;
  wipBranch: string;
}): FreshMainCheckout {
  const gitDir = mirrorPath(options.pawsRoot, options.owner, options.repo);
  const tree = worktreePath(options.pawsRoot, options.itemId);
  const base = {
    restarted: false as const,
    wipBranch: options.wipBranch,
    worktreePath: tree,
  };
  if (!safeBranch(options.wipBranch)) return { ...base, reason: "bad_branch" };
  if (!existsSync(gitDir)) return { ...base, reason: "no_mirror" };

  let wipSha: string | undefined;
  if (isRegisteredWorktree(gitDir, tree)) {
    const committed = commitCheckpointSync(tree, "wip: paused");
    wipSha = committed.sha ?? gitSyncOrEmpty(["-C", tree, "rev-parse", "HEAD"]);
    gitSync(["--git-dir", gitDir, "worktree", "remove", "--force", tree]);
    gitSync(["--git-dir", gitDir, "worktree", "prune"]);
  } else if (refExists(gitDir, options.wipBranch)) {
    wipSha = gitSyncOrEmpty(["--git-dir", gitDir, "rev-parse", "--verify", options.wipBranch]);
  }

  const startRef = resolveStartRefSync(gitDir);
  if (startRef === undefined) return { ...base, ...(wipSha ? { wipSha } : {}), reason: "no_main" };
  if (existsSync(tree)) return { ...base, ...(wipSha ? { wipSha } : {}), reason: "path_busy" };

  mkdirSync(dirname(tree), { recursive: true, mode: 0o700 });
  const branch = freshBranchName(gitDir, options.wipBranch);
  gitSync(["--git-dir", gitDir, "worktree", "add", "-b", branch, tree, startRef]);
  const kept = gitSyncOrEmpty(["--git-dir", gitDir, "rev-parse", "--verify", options.wipBranch]);
  if (wipSha !== undefined && kept !== wipSha) {
    gitSync(["--git-dir", gitDir, "update-ref", `refs/heads/${options.wipBranch}`, wipSha]);
  }
  const recorded = gitSyncOrEmpty([
    "--git-dir",
    gitDir,
    "rev-parse",
    "--verify",
    options.wipBranch,
  ]);
  return {
    restarted: true,
    wipBranch: options.wipBranch,
    ...((recorded ?? wipSha) ? { wipSha: recorded ?? wipSha } : {}),
    worktreePath: tree,
    startRef,
    branch,
  };
}

function safeBranch(branch: string): boolean {
  return /^[\w./-]+$/.test(branch) && !branch.includes("..") && !branch.startsWith("-");
}

function commitArgs(tree: string, message: string): string[] {
  return [
    "-C",
    tree,
    "-c",
    "commit.gpgsign=false",
    "-c",
    "user.name=Paws",
    "-c",
    "user.email=paws@localhost",
    "commit",
    "--no-verify",
    "-m",
    message,
  ];
}

function gitSync(args: string[], env?: NodeJS.ProcessEnv): string {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    env: env ?? process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
    throw new Error(
      `git ${args.join(" ")} failed (${result.status ?? "signal"}): ${stderr || "no stderr"}`,
    );
  }
  return result.stdout;
}

function gitSyncOrEmpty(args: string[]): string | undefined {
  try {
    const value = gitSync(args).trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function refExists(gitDir: string, ref: string): boolean {
  return (
    gitSyncOrEmpty(["--git-dir", gitDir, "rev-parse", "--verify", "--quiet", ref]) !== undefined
  );
}

function resolveStartRefSync(gitDir: string): string | undefined {
  for (const ref of START_REFS) {
    if (refExists(gitDir, ref)) return ref;
  }
  return undefined;
}

function isRegisteredWorktree(gitDir: string, path: string): boolean {
  const listed = gitSyncOrEmpty(["--git-dir", gitDir, "worktree", "list", "--porcelain"]);
  if (listed === undefined) return false;
  const resolved = path.endsWith("/") ? path.slice(0, -1) : path;
  return listed.split("\n").some((line) => line === `worktree ${resolved}`);
}

function freshBranchName(gitDir: string, wipBranch: string): string {
  const base = `${wipBranch}-fresh`;
  if (base === wipBranch) throw new Error("fresh branch would replace the WIP branch");
  if (!refExists(gitDir, base)) return base;
  const listed = gitSync(["--git-dir", gitDir, "worktree", "list", "--porcelain"]);
  const inUse = listed.split("\n").some((line) => line === `branch refs/heads/${base}`);
  if (!inUse) {
    gitSync(["--git-dir", gitDir, "branch", "-D", base]);
    return base;
  }
  for (let generation = 2; generation < 50; generation += 1) {
    const name = `${base}-${generation}`;
    if (!refExists(gitDir, name)) return name;
  }
  throw new Error(`no free branch name near ${base}`);
}
