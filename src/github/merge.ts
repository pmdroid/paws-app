import { journalCaught } from "../journal";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { acquireOperationToken } from "./auth/provider";
import type { GitHubTokenProvider } from "./auth/types";
import { branchForIssue, fixesLine, githubHttpsUrl } from "./branch";
import { repoApiPath } from "./client";
import { defaultGitExec, git, gitEnv, gitFailureReason, redact, withCredential } from "./git";
import { mainOverlap, readUpToDateRule } from "./overlap";
import { pushDenial, pushWithLease } from "./push";
import { gitTempDirectory } from "./temp";
import { pushOutageCause } from "./transport";
import { readPullMergeable } from "./pull-mergeable";
import { waitForMergeReadiness, type Readiness } from "./readiness";
import { readPullReview, type PullReview } from "./review";
import { isTransient } from "../core";
import {
  GitCommandError,
  UPSTREAM_MAIN_REF,
  type GitExec,
  type GitHubClient,
  type SerialMergeResult,
} from "./types";

export type SerialMergeInput = {
  /** The repository the lane's git commands run in: the item worktree or the bare mirror. */
  worktree: string;
  /**
   * The ref that names S in `worktree`; `HEAD` when unset. A runner-backed item has no worktree,
   * so its S is its candidate ref in the bare mirror.
   */
  ref?: string;
  publishedAt?: (head: string) => number | null | Promise<number | null>;
  issue: string;
  branchKey?: string;
  owner: string;
  repo: string;
  prNumber: number;
  appId: string;
  installationId: string;
  privateKeyPem: string;
  client: GitHubClient;
  /** When set, push and merge each ask this provider. Otherwise the App mint path is used. */
  tokenProvider?: GitHubTokenProvider;
  remoteUrl?: string;
  now?: () => Date;
  gitExec?: GitExec;
  /** Observability for the host. Do not log the token. */
  onCredential?: (purpose: "push" | "merge", token: string) => void;
  /** Runs after preparation, immediately before the squash PUT can reach GitHub. */
  beforeMergeCall?: (head: string) => Promise<void>;
  commitTitle?: string;
  commitMessage?: string;
  commitEnv?: Record<string, string>;
  sleep?: (ms: number) => Promise<void>;
  isCancelled?: () => Promise<boolean>;
  /**
   * `[merge] main_moved = "overlap"`: compare main's new commits with the pull request's files,
   * grouped by these package roots, when S is behind main.
   */
  overlap?: { packages: readonly string[]; anyFiles?: boolean };
};

/** What the merge lane reads about the branch head S under the repository lock. */
export type PullFacts = {
  branch: string;
  /** S: the branch head Paws holds, which is the head the pull request should carry. */
  head: string;
  /** Main as just fetched. */
  base: string;
  containsMain: boolean;
  /**
   * Only with `overlap`, for S behind main: main's new commits touch none of S's files or package
   * roots, and GitHub does not require branches to be up to date. S may merge without a rebase.
   */
  apart?: boolean;
  /** With `overlap`: the files or package roots main's new commits share with S. */
  shared?: string[];
  /** With `overlap`: GitHub requires branches to be up to date, so S is rebased anyway. */
  upToDateRule?: boolean;
  /** CI and review threads for S, and whether the pull request still carries S. */
  readiness: Readiness;
  review: PullReview;
};

export type PullFactsRead =
  | ({ kind: "facts" } & PullFacts)
  | { kind: "stopped"; result: SerialMergeResult };

/**
 * Fetch main and read the facts `mergeable(S)` needs. Changes nothing: no rebase, no push, no
 * merge. CI that is still pending is read once and not waited for.
 */
export async function readPullFacts(input: SerialMergeInput): Promise<PullFactsRead> {
  const branch = laneBranch(input);
  if (typeof branch !== "string") return { kind: "stopped", result: branch };
  const gitExec = input.gitExec ?? defaultGitExec();
  const ref = input.ref ?? "HEAD";
  // A bare mirror has no work tree to be dirty.
  const status = input.ref ? "" : await git(input.worktree, ["status", "--porcelain"], gitExec);
  if (status !== "")
    return {
      kind: "stopped",
      result: {
        merged: false,
        outcome: "dirty",
        branch,
        message: "worktree has uncommitted changes",
      },
    };
  if (await input.isCancelled?.()) return { kind: "stopped", result: cancelled(branch) };
  const token = await operationToken(input, "merge");
  input.onCredential?.("merge", token);
  const url = input.remoteUrl ?? githubHttpsUrl(input.owner, input.repo);
  await fetchMain(input.worktree, url, token, gitExec, input.sleep);
  const base = await git(input.worktree, ["rev-parse", UPSTREAM_MAIN_REF], gitExec);
  const head = await git(input.worktree, ["rev-parse", ref], gitExec);
  const containsMain = await git(
    input.worktree,
    ["merge-base", "--is-ancestor", UPSTREAM_MAIN_REF, ref],
    gitExec,
  ).then(
    () => true,
    () => false,
  );
  const readiness = await waitForMergeReadiness({
    ...input,
    head,
    token: async () => token,
    releaseWhilePending: true,
  });
  const review = await readPullReview({ ...input, tokenProvider: input.tokenProvider });
  const overlap =
    input.overlap && !containsMain ? await readOverlap(input, token, gitExec) : undefined;
  return { kind: "facts", branch, head, base, containsMain, ...overlap, readiness, review };
}

/**
 * Whether S, behind main, may merge without a rebase under `overlap`. A shared file or package
 * root, GitHub's up-to-date rule, or a rule Paws cannot read all mean it may not.
 */
async function readOverlap(
  input: SerialMergeInput,
  token: string,
  gitExec: GitExec,
): Promise<Pick<PullFacts, "apart" | "shared" | "upToDateRule">> {
  const { shared } = input.overlap?.anyFiles
    ? { shared: [] as string[] }
    : await mainOverlap(input.worktree, input.overlap?.packages ?? [], gitExec, input.ref);
  if (shared.length > 0) return { apart: false, shared };
  const rule = await readUpToDateRule({
    client: input.client,
    token,
    owner: input.owner,
    repo: input.repo,
    branch: "main",
    prNumber: input.prNumber,
  }).catch((caughtError) => {
    journalCaught(caughtError, "merge.readOverlap.readUpToDateRule", input.issue);
    return null;
  });
  if (rule === true) return { apart: false, shared, upToDateRule: true };
  return { apart: rule === false, shared };
}

export type RebaseResult =
  | { rebased: true; branch: string; base: string; head: string }
  | { rebased: false; result: SerialMergeResult };

/**
 * Rebase the branch onto the fetched main and push it. The new head needs Closeout again, or
 * under `ci` and `overlap` carries the acceptance of the head it was rebased from.
 */
export async function rebaseOntoMain(input: SerialMergeInput): Promise<RebaseResult> {
  const branch = laneBranch(input);
  if (typeof branch !== "string") return { rebased: false, result: branch };
  if (await input.isCancelled?.()) return { rebased: false, result: cancelled(branch) };
  const url = input.remoteUrl ?? githubHttpsUrl(input.owner, input.repo);
  const gitExec = input.gitExec ?? defaultGitExec();
  const pushed = input.ref
    ? await rebaseInCheckout(input, input.ref, url, branch, gitExec)
    : await pushRebased(input, url, branch, gitExec);
  if (!pushed.ok) return { rebased: false, result: pushed.result };
  return { rebased: true, branch, base: pushed.base, head: pushed.head };
}

const RUNNER_REBASED_REF = "refs/paws/runner-rebased";

export async function adoptRunnerRebase(
  input: SerialMergeInput,
  heads: { head: string; base: string; rebased: string },
  signal: AbortSignal,
): Promise<RebaseResult | { refused: string }> {
  const branch = laneBranch(input);
  if (typeof branch !== "string") return { rebased: false, result: branch };
  if (await input.isCancelled?.()) return { rebased: false, result: cancelled(branch) };
  const gitExec = input.gitExec ?? defaultGitExec();
  const run = async (args: string[]) =>
    (await gitExec(args, { cwd: input.worktree, env: gitEnv(), signal })).stdout.trim();
  const token = await operationToken(input, "merge");
  const url = input.remoteUrl ?? githubHttpsUrl(input.owner, input.repo);
  await withCredential(
    token,
    gitExec,
    (helper) =>
      helper.exec(
        [...helper.argsPrefix, "fetch", url, `+refs/heads/${branch}:${RUNNER_REBASED_REF}`],
        { cwd: input.worktree, env: helper.env, signal },
      ),
    { sleep: input.sleep },
  ).catch((error: unknown) => {
    signal.throwIfAborted();
    throw new Error(`fetch failed: ${gitFailureReason(token, error)}`, { cause: error });
  });
  const fetched = await run(["rev-parse", RUNNER_REBASED_REF]);
  if (fetched !== heads.rebased) return { refused: `the branch is at ${fetched.slice(0, 7)}` };
  const descends = await run(["merge-base", "--is-ancestor", heads.base, heads.rebased]).then(
    () => true,
    () => false,
  );
  signal.throwIfAborted();
  if (!descends) return { refused: `it does not descend from main ${heads.base.slice(0, 7)}` };
  const oldBase = await run(["merge-base", heads.base, heads.head]);
  const [before, after] = await Promise.all([
    patchId(input.worktree, oldBase, heads.head, signal),
    patchId(input.worktree, heads.base, heads.rebased, signal),
  ]);
  if (before !== after) return { refused: "its patch-id differs from the accepted head's" };
  if (input.ref) await run(["update-ref", input.ref, heads.rebased, heads.head]);
  else await run(["reset", "--hard", heads.rebased]);
  return { rebased: true, branch, base: heads.base, head: heads.rebased };
}

async function patchId(
  worktree: string,
  from: string,
  to: string,
  signal: AbortSignal,
): Promise<string> {
  const env = gitEnv();
  const diff = spawn(
    "git",
    ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-renames", from, to],
    { cwd: worktree, env, signal, stdio: ["ignore", "pipe", "pipe"] },
  );
  const id = spawn("git", ["patch-id", "--stable"], {
    cwd: worktree,
    env,
    signal,
    stdio: ["pipe", "pipe", "pipe"],
  });
  id.stdin.on("error", () => diff.kill());
  diff.stdout.pipe(id.stdin);
  let stdout = "";
  id.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  const exited = (child: ReturnType<typeof spawn>) =>
    new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  const [diffCode, idCode] = await Promise.all([exited(diff), exited(id)]);
  signal.throwIfAborted();
  if (diffCode !== 0 || idCode !== 0)
    throw new GitCommandError(["patch-id", from, to], `git exited ${diffCode ?? idCode}`);
  return stdout.trim().split(" ")[0] ?? "";
}

/**
 * Squash-merge the pull request only if main is still the `base` the facts were read against, CI and
 * review threads for `head` are still ready, and GitHub still carries `head`. GitHub's expected-head guard covers the pull request head only, so
 * main is fetched again first: a newer main is reported as `sha_moved` and the lane reads again.
 * GitHub refusing a moved head with 409 is `sha_moved` too. Neither is retried here.
 */
export async function squashPull(
  input: SerialMergeInput,
  expected: { head: string; base: string },
  summary: string,
): Promise<SerialMergeResult> {
  const expectedHead = expected.head;
  const branch = laneBranch(input);
  if (typeof branch !== "string") return branch;
  if (await input.isCancelled?.()) return cancelled(branch);
  const token = await operationToken(input, "merge");
  input.onCredential?.("merge", token);
  const gitExec = input.gitExec ?? defaultGitExec();
  const url = input.remoteUrl ?? githubHttpsUrl(input.owner, input.repo);
  await fetchMain(input.worktree, url, token, gitExec, input.sleep);
  const baseNow = await git(input.worktree, ["rev-parse", UPSTREAM_MAIN_REF], gitExec);
  if (baseNow !== expected.base)
    return {
      merged: false,
      outcome: "sha_moved",
      branch,
      base: baseNow,
      head: expectedHead,
      message: "main moved before merge",
    };
  // CI or review threads can change while main is fetched, and GitHub's expected-head guard only
  // refuses a moved head. Read them once more for S; anything but ready stops the squash.
  const recheck = await waitForMergeReadiness({
    ...input,
    head: expectedHead,
    token: async () => token,
    releaseWhilePending: true,
  });
  if (recheck.outcome !== "ready")
    return {
      merged: false,
      outcome: recheck.outcome === "sha_moved" ? "sha_moved" : "blocked",
      branch,
      head: expectedHead,
      message: recheck.message,
      readiness: recheck,
    };
  // A stop or withdrawn publication during the reads must still win.
  if (await input.isCancelled?.()) return cancelled(branch);
  const merged = await squash(input, token, expectedHead, summary);
  // A server error or an unreadable success response can arrive after GitHub committed the merge.
  // Keep the caller's durable marker until a pull request read establishes the outcome.
  if (
    merged === null ||
    merged.status >= 500 ||
    merged.status === 408 ||
    (merged.status === 200 && (!isRecord(merged.body) || typeof merged.body.merged !== "boolean"))
  )
    return {
      merged: false,
      outcome: "unknown",
      branch,
      head: expectedHead,
      message: "Waiting for GitHub to confirm the squash outcome.",
    };
  if (merged.status === 409)
    return {
      merged: false,
      outcome: "sha_moved",
      branch,
      head: expectedHead,
      message: "pull request head changed before merge",
    };
  if (merged.status !== 200 || !isRecord(merged.body) || merged.body.merged !== true) {
    if (merged.status !== 401 && merged.status !== 403) {
      const base = await behindMain(input, token, gitExec, url);
      if (base !== null)
        return {
          merged: false,
          outcome: "sha_moved",
          branch,
          base,
          head: expectedHead,
          message: "GitHub refused the merge: the branch is behind main",
        };
    }
    const reason = denialReason(merged.body);
    return {
      merged: false,
      outcome: "merge_denied",
      branch,
      head: expectedHead,
      summary,
      status: merged.status,
      ...(reason ? { reason } : {}),
      message: `merge failed with status ${merged.status}${reason ? `: ${reason}` : ""}`,
    };
  }
  const sha = typeof merged.body.sha === "string" ? merged.body.sha : undefined;
  return {
    merged: true,
    outcome: "merged",
    branch,
    head: expectedHead,
    ...(sha ? { sha } : {}),
    summary,
  };
}

async function behindMain(
  input: SerialMergeInput,
  token: string,
  gitExec: GitExec,
  url: string,
): Promise<string | null> {
  const { client, owner, repo, prNumber, tokenProvider } = input;
  const pull = await readPullMergeable({
    client,
    owner,
    repo,
    prNumber,
    reads: 1,
    ...(tokenProvider
      ? { tokenProvider }
      : {
          appId: input.appId,
          installationId: input.installationId,
          privateKeyPem: input.privateKeyPem,
        }),
  });
  if (pull?.behind !== true) return null;
  try {
    await fetchMain(input.worktree, url, token, gitExec, input.sleep);
    const contains = await git(
      input.worktree,
      ["merge-base", "--is-ancestor", UPSTREAM_MAIN_REF, input.ref ?? "HEAD"],
      gitExec,
    ).then(
      () => true,
      () => false,
    );
    return contains ? null : await git(input.worktree, ["rev-parse", UPSTREAM_MAIN_REF], gitExec);
  } catch (error) {
    journalCaught(error, "merge.behindMain", input.issue);
    return null;
  }
}

const DENIAL_REASON_LIMIT = 500;

function denialReason(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const first = Array.isArray(body.errors) ? body.errors[0] : undefined;
  const detail = typeof first === "string" ? first : isRecord(first) ? first.message : undefined;
  const parts = [body.message, detail].filter(
    (part): part is string => typeof part === "string" && part.trim() !== "",
  );
  const reason = [...new Set(parts.map((part) => part.trim()))].join(": ");
  return reason === "" ? undefined : reason.slice(0, DENIAL_REASON_LIMIT);
}

function laneBranch(input: SerialMergeInput): string | SerialMergeResult {
  if (!Number.isInteger(input.prNumber) || input.prNumber < 1)
    return {
      merged: false,
      outcome: "merge_denied",
      branch: safeBranch(input.branchKey ?? input.issue),
      message: "pull number is invalid",
    };
  return branchForIssue(input.branchKey ?? input.issue);
}

function cancelled(branch: string): SerialMergeResult {
  return { merged: false, outcome: "blocked", branch, message: "merge cancelled" };
}

/**
 * A bare mirror has no work tree to rebase in. The rebase runs in a detached checkout of `ref`
 * under the Git temp directory, never under the worktrees, and `ref` moves to the pushed head.
 */
async function rebaseInCheckout(
  input: SerialMergeInput,
  ref: string,
  url: string,
  branch: string,
  gitExec: GitExec,
): Promise<Awaited<ReturnType<typeof pushRebased>>> {
  const before = await git(input.worktree, ["rev-parse", "--verify", `${ref}^{commit}`], gitExec);
  const dir = await gitTempDirectory("paws-rebase-");
  const tree = path.join(dir, "tree");
  try {
    await git(input.worktree, ["worktree", "add", "--detach", tree, before], gitExec);
    const checkout: SerialMergeInput = { ...input, worktree: tree };
    delete checkout.ref;
    const pushed = await pushRebased(checkout, url, branch, gitExec);
    if (pushed.ok) await git(input.worktree, ["update-ref", ref, pushed.head, before], gitExec);
    return pushed;
  } finally {
    await git(input.worktree, ["worktree", "remove", "--force", tree], gitExec).catch(
      (caughtError) => journalCaught(caughtError, "merge.rebaseInCheckout.remove", input.issue),
    );
    await rm(dir, { recursive: true, force: true });
  }
}

async function pushRebased(
  input: SerialMergeInput,
  url: string,
  branch: string,
  gitExec: GitExec,
): Promise<{ ok: true; base: string; head: string } | { ok: false; result: SerialMergeResult }> {
  const minted = await operationToken(input, "push");
  input.onCredential?.("push", minted);
  try {
    await fetchMain(input.worktree, url, minted, gitExec, input.sleep);
    const base = await git(input.worktree, ["rev-parse", UPSTREAM_MAIN_REF], gitExec);
    const before = await git(input.worktree, ["rev-parse", "HEAD"], gitExec);
    const commitExec: GitExec = input.commitEnv
      ? (args, options) =>
          gitExec(args, { ...options, env: { ...options.env, ...input.commitEnv } })
      : gitExec;
    const rebase = await rebaseOnto(input.worktree, UPSTREAM_MAIN_REF, commitExec);
    if (rebase.kind !== "ok") {
      return {
        ok: false,
        result: {
          merged: false,
          outcome: rebase.kind === "conflict" ? "conflict" : "rebase_failed",
          branch,
          base,
          message: rebase.kind === "conflict" ? "rebase conflict" : "rebase failed",
          ...(rebase.kind === "conflict" && rebase.files.length > 0
            ? { conflictFiles: rebase.files }
            : {}),
        },
      };
    }
    try {
      await pushWithLease({
        worktree: input.worktree,
        url,
        branch,
        token: minted,
        gitExec,
        sleep: input.sleep,
      });
    } catch (error) {
      // The push waits out the outage: keep the head the lane started from, not one GitHub lacks.
      if (pushOutageCause(error)) await git(input.worktree, ["reset", "--hard", before], gitExec);
      const denial =
        error instanceof GitCommandError
          ? pushDenial(redact(minted, error.stderr), {
              owner: input.owner,
              repo: input.repo,
              installationId: input.installationId,
            })
          : null;
      throw new Error(`push rejected: ${denial ?? gitFailureReason(minted, error)}`, {
        cause: error,
      });
    }
    const head = await git(input.worktree, ["rev-parse", "HEAD"], gitExec);
    return { ok: true, base, head };
  } catch (error) {
    // A push outage holds the push for the lane to retry; it is not a rejection of this head.
    if (isTransient(error) || pushOutageCause(error)) throw error;
    const message = redact(minted, error instanceof Error ? error.message : String(error));
    journalCaught(message, "merge.pushRebased", input.issue);
    return { ok: false, result: { merged: false, outcome: "push_rejected", branch, message } };
  }
}

export type FetchUpstreamMainInput = Pick<
  SerialMergeInput,
  "worktree" | "owner" | "repo" | "client" | "tokenProvider" | "remoteUrl" | "now" | "gitExec"
> &
  Partial<Pick<SerialMergeInput, "appId" | "installationId" | "privateKeyPem">>;

/** Fetch main into {@link UPSTREAM_MAIN_REF}, as a merge pass does before it rebases. Returns its sha. */
export async function fetchUpstreamMain(input: FetchUpstreamMainInput): Promise<string> {
  const gitExec = input.gitExec ?? defaultGitExec();
  const token = await operationToken(input, "push");
  await fetchMain(
    input.worktree,
    input.remoteUrl ?? githubHttpsUrl(input.owner, input.repo),
    token,
    gitExec,
  );
  return git(input.worktree, ["rev-parse", UPSTREAM_MAIN_REF], gitExec);
}

async function fetchMain(
  worktree: string,
  url: string,
  token: string,
  gitExec: GitExec,
  sleep?: (ms: number) => Promise<void>,
): Promise<void> {
  await withCredential(
    token,
    gitExec,
    async (helper) => {
      try {
        await helper.exec(
          [...helper.argsPrefix, "fetch", url, `+refs/heads/main:${UPSTREAM_MAIN_REF}`],
          { cwd: worktree, env: helper.env },
        );
      } catch (error) {
        throw new Error(`fetch failed: ${gitFailureReason(token, error)}`, { cause: error });
      }
    },
    { sleep },
  );
}

async function rebaseOnto(
  worktree: string,
  onto: string,
  gitExec: GitExec,
): Promise<{ kind: "ok" } | { kind: "conflict"; files: string[] } | { kind: "failed" }> {
  try {
    await git(worktree, ["rebase", onto], gitExec);
    return { kind: "ok" };
  } catch (caughtError2) {
    journalCaught(caughtError2, "merge.rebaseOnto.git", null);
    const gitPath = await git(worktree, ["rev-parse", "--git-path", "rebase-merge"], gitExec).catch(
      (caughtError3) => {
        journalCaught(caughtError3, "merge.rebaseOnto.git", null);
        return "";
      },
    );
    const resolved =
      gitPath === "" ? "" : path.isAbsolute(gitPath) ? gitPath : path.resolve(worktree, gitPath);
    if (resolved !== "" && existsSync(resolved)) {
      const unmerged = await git(
        worktree,
        ["diff", "--name-only", "--diff-filter=U"],
        gitExec,
      ).catch((caughtError4) => {
        journalCaught(caughtError4, "merge.rebaseOnto.git", null);
        return "";
      });
      await git(worktree, ["rebase", "--abort"], gitExec).catch((caughtError5) => {
        journalCaught(caughtError5, "merge.rebaseOnto.git", null);
        return "";
      });
      return { kind: "conflict", files: unmerged.split("\n").filter((file) => file !== "") };
    }
    return { kind: "failed" };
  }
}

async function squash(
  input: SerialMergeInput,
  token: string,
  head: string,
  summary: string,
): Promise<{ status: number; body: unknown } | null> {
  const request: Parameters<GitHubClient["request"]>[0] = {
    method: "PUT",
    path: repoApiPath(input.owner, input.repo, `/pulls/${input.prNumber}/merge`),
    token,
    body: {
      merge_method: "squash",
      sha: head,
      commit_title: input.commitTitle ?? input.issue,
      commit_message: `${fixesLine(input.issue)}\n\n${(input.commitMessage ?? summary).trim()}\n`,
    },
  };
  await input.beforeMergeCall?.(head);
  try {
    return await input.client.request(request);
  } catch (error) {
    // Cancellation belongs to the owner. It must retain the marker and propagate normally.
    if ((await input.isCancelled?.()) || (error instanceof Error && error.name === "AbortError"))
      throw error;
    // Only the PUT was attempted here. Preparation and request construction errors propagate.
    journalCaught(error, "merge.squash.request", input.issue);
    return null;
  }
}

function operationToken(input: FetchUpstreamMainInput, purpose: "push" | "merge"): Promise<string> {
  return acquireOperationToken(
    {
      tokenProvider: input.tokenProvider,
      client: input.client,
      appId: input.appId,
      installationId: input.installationId,
      privateKeyPem: input.privateKeyPem,
      owner: input.owner,
      repo: input.repo,
      ...(input.now ? { now: input.now() } : {}),
    },
    purpose,
  );
}

function safeBranch(issue: string): string {
  try {
    return branchForIssue(issue);
  } catch (caughtError6) {
    journalCaught(caughtError6, "merge.safeBranch.branchForIssue", null);
    return "paws/invalid";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
