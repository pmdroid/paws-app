import { journalCaught } from "../journal";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
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

export interface CheckpointResult {
  committed: boolean;
  sha?: string;
  message: string;
}

const DEFAULT_IDENTITY = { name: "Paws", email: "paws@localhost" };

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
