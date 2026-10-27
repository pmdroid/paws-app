import { journalCaught } from "../journal";
import { checkoutExclusionsFor, loadConfigFile } from "../config";
import { checkoutPatternsSync, exclusionPatterns } from "../worktree-checkout";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  appBotCommitIdentity,
  commitPolicyMessage,
  commitIdentityEnv,
  type GitCommitIdentity,
  type GitCommitPolicy,
} from "../core";
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

const DEFAULT_IDENTITY = { name: "Paws", email: "paws@localhost" };

/** Same order as worktree start refs: a published main, then whatever the mirror has. */
const START_REFS = ["origin/main", "main", "origin/master", "HEAD"] as const;

/**
 * Commit whatever is dirty in the item worktree. A clean tree is left as it is.
 * Hooks are skipped so a cancel or timeout still records the checkpoint.
 */
export async function commitCheckpoint(
  tree: string,
  message = "wip: checkpoint",
  signal?: AbortSignal,
  onPublished?: () => void,
  environment?: NodeJS.ProcessEnv,
  excludePaths: readonly string[] = [],
  identity: GitCommitIdentity = DEFAULT_IDENTITY,
): Promise<CheckpointResult> {
  const commitEnv = commitIdentityEnv(identity);
  const unchanged = { committed: false, message };
  if (signal?.aborted) return unchanged;
  const baseEnv = environment ?? process.env;
  const index = (
    await git(["-C", tree, "rev-parse", "--path-format=absolute", "--git-path", "index"], {
      env: baseEnv,
    })
  ).trim();
  const temporary = await mkdtemp(join(dirname(index), "paws-checkpoint-"));
  try {
    const head = (await git(["-C", tree, "rev-parse", "HEAD"], { env: baseEnv })).trim();
    const ref = (
      await git(["-C", tree, "rev-parse", "--symbolic-full-name", "HEAD"], { env: baseEnv })
    ).trim();
    const originalIndex = existsSync(index) ? readFileSync(index) : undefined;
    const privateIndex = join(temporary, "index");
    const env = { ...baseEnv, ...commitEnv, GIT_INDEX_FILE: privateIndex };
    if (originalIndex) {
      writeFileSync(privateIndex, originalIndex);
      const { atime, mtime } = statSync(index);
      utimesSync(privateIndex, atime, mtime);
    } else await git(["-C", tree, "read-tree", head], { env });
    if (excludePaths.length)
      await git(
        [
          "-C",
          tree,
          "rm",
          "-r",
          "--cached",
          "--ignore-unmatch",
          "--",
          ...excludePaths.map((path) => `:(literal)${path}`),
        ],
        { env },
      );
    const status = (await git(["-C", tree, "status", "--porcelain"], { env })).trim();
    if (!status || signal?.aborted) return unchanged;
    await git(
      [
        "-C",
        tree,
        "add",
        "-A",
        "--",
        ".",
        ...excludePaths.map((path) => `:(exclude,literal)${path}`),
      ],
      { env },
    );
    if (signal?.aborted) return unchanged;
    const snapshot = (await git(["-C", tree, "write-tree"], { env })).trim();
    if (signal?.aborted) return unchanged;
    if (
      excludePaths.length &&
      snapshot === (await git(["-C", tree, "rev-parse", `${head}^{tree}`], { env })).trim()
    )
      return unchanged;
    const sha = (
      await git(
        [
          "-C",
          tree,
          "-c",
          "commit.gpgsign=false",
          "commit-tree",
          snapshot,
          "-p",
          head,
          "-m",
          message,
        ],
        { env },
      )
    ).trim();
    if (signal?.aborted) return unchanged;
    const indexLock = `${index}.lock`;
    const fd = openSync(indexLock, "wx", 0o600);
    let published = false;
    try {
      try {
        writeFileSync(fd, readFileSync(privateIndex));
      } finally {
        closeSync(fd);
      }
      const currentIndex = existsSync(index) ? readFileSync(index) : undefined;
      if (originalIndex ? !currentIndex?.equals(originalIndex) : currentIndex !== undefined)
        throw new Error("Git index changed while preparing checkpoint");
      if (gitSync(["-C", tree, "rev-parse", "--symbolic-full-name", "HEAD"], env).trim() !== ref)
        throw new Error("Git HEAD changed while preparing checkpoint");
      gitSync(["-C", tree, "update-ref", "-m", message, ref, sha, head], env);
      try {
        renameSync(indexLock, index);
      } catch (error) {
        try {
          gitSync(
            ["-C", tree, "update-ref", "-m", "checkpoint index publication failed", ref, head, sha],
            env,
          );
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "Checkpoint index publication and branch rollback failed",
            { cause: rollbackError },
          );
        }
        throw error;
      }
      published = true;
      onPublished?.();
    } finally {
      if (!published) rmSync(indexLock, { force: true });
    }
    return { committed: true, sha, message };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export interface WorktreeSnapshot {
  /** The branch commit the snapshot is made on. */
  head: string;
  /** The tree of the worktree as it is, uncommitted changes included. */
  tree: string;
  /** `head` when nothing is uncommitted, otherwise a new commit of `tree` on `head`. */
  sha: string;
}

/**
 * The worktree as one commit, for a checkpoint while its agent keeps working. Unlike
 * `commitCheckpoint` it leaves the branch, the index and the files as they are.
 */
export async function snapshotWorktree(
  tree: string,
  message: string,
  environment?: NodeJS.ProcessEnv,
  excludePaths: readonly string[] = [],
  identity: GitCommitIdentity = DEFAULT_IDENTITY,
  /** Make a new commit even when nothing is uncommitted, so the snapshot is not `head` itself. */
  always = false,
): Promise<WorktreeSnapshot> {
  const baseEnv = environment ?? process.env;
  const index = (
    await git(["-C", tree, "rev-parse", "--path-format=absolute", "--git-path", "index"], {
      env: baseEnv,
    })
  ).trim();
  const temporary = await mkdtemp(join(dirname(index), "paws-snapshot-"));
  try {
    const head = (await git(["-C", tree, "rev-parse", "HEAD"], { env: baseEnv })).trim();
    const privateIndex = join(temporary, "index");
    const env = { ...baseEnv, ...commitIdentityEnv(identity), GIT_INDEX_FILE: privateIndex };
    if (existsSync(index)) writeFileSync(privateIndex, readFileSync(index));
    else await git(["-C", tree, "read-tree", head], { env });
    await git(
      [
        "-C",
        tree,
        "add",
        "-A",
        "--",
        ".",
        ...excludePaths.map((path) => `:(exclude,literal)${path}`),
      ],
      { env },
    );
    if (excludePaths.length)
      await git(
        [
          "-C",
          tree,
          "rm",
          "-r",
          "--cached",
          "--ignore-unmatch",
          "--quiet",
          "--",
          ...excludePaths.map((path) => `:(literal)${path}`),
        ],
        { env },
      );
    const snapshot = (await git(["-C", tree, "write-tree"], { env })).trim();
    if (
      !always &&
      snapshot === (await git(["-C", tree, "rev-parse", `${head}^{tree}`], { env })).trim()
    )
      return { head, tree: snapshot, sha: head };
    const sha = (
      await git(
        [
          "-C",
          tree,
          "-c",
          "commit.gpgsign=false",
          "commit-tree",
          snapshot,
          "-p",
          head,
          "-m",
          message,
        ],
        { env },
      )
    ).trim();
    return { head, tree: snapshot, sha };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/**
 * Same commit as `commitCheckpoint`, run synchronously so SIGTERM can finish
 * it before exit. A missing worktree records nothing.
 */
export function commitCheckpointSync(
  tree: string,
  message = "wip: shutdown",
  identity: GitCommitIdentity = DEFAULT_IDENTITY,
  policy?: GitCommitPolicy,
): CheckpointResult {
  if (policy) {
    identity = appBotCommitIdentity(policy.bot);
    message = commitPolicyMessage(message, policy);
  }
  const commitEnv = commitIdentityEnv(identity);
  if (!existsSync(tree)) return { committed: false, message };
  let status: string;
  try {
    status = gitSync(["-C", tree, "status", "--porcelain"]).trim();
  } catch (caughtError1) {
    journalCaught(caughtError1, "checkpoint.commitCheckpointSync.trim", null);
    return { committed: false, message };
  }
  if (!status) return { committed: false, message };
  gitSync(["-C", tree, "add", "-A"]);
  gitSync(commitArgs(tree, message), { ...process.env, ...commitEnv });
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
  commitIdentity?: GitCommitIdentity;
  commitPolicy?: GitCommitPolicy;
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

  const patterns = exclusionPatterns(
    checkoutExclusionsFor(
      loadConfigFile(join(options.pawsRoot, "config.toml")).checkoutProjects,
      `${options.owner}/${options.repo}`,
    ).agent,
  );
  let wipSha: string | undefined;
  if (isRegisteredWorktree(gitDir, tree)) {
    const committed = commitCheckpointSync(
      tree,
      "wip: paused",
      options.commitIdentity,
      options.commitPolicy,
    );
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
  gitSync(["--git-dir", gitDir, "worktree", "add", "--no-checkout", "-b", branch, tree, startRef]);
  try {
    checkoutPatternsSync(tree, patterns);
  } catch (error) {
    gitSyncOrEmpty(["--git-dir", gitDir, "worktree", "remove", "--force", tree]);
    throw error;
  }
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
  } catch (caughtError2) {
    journalCaught(caughtError2, "checkpoint.gitSyncOrEmpty.trim", null);
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
