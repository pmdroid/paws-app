import { journalCaught } from "../journal";
import { existsSync } from "node:fs";
import path from "node:path";
import { acquireOperationToken } from "./auth/provider";
import type { GitHubTokenProvider } from "./auth/types";
import { branchForIssue, fixesLine, githubHttpsUrl } from "./branch";
import { repoApiPath } from "./client";
import { defaultGitExec, git, gitFailureReason, redact, withCredential } from "./git";
import { mainOverlap, readUpToDateRule } from "./overlap";
import { pushDenial, pushWithLease } from "./push";
import { pushOutageCause } from "./transport";
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
  worktree: string;
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
  beforeMergeCall?: (head: string) => void;
  commitTitle?: string;
  commitMessage?: string;
  commitEnv?: Record<string, string>;
  sleep?: (ms: number) => Promise<void>;
  isCancelled?: () => boolean;
  /**
   * `[merge] main_moved = "overlap"`: compare main's new commits with the pull request's files,
   * grouped by these package roots, when S is behind main.
   */
  overlap?: { packages: readonly string[]; anyFiles?: boolean };
};

/** What the merge lane reads about the branch head S under the repository lock. */
export type PullFacts = {
  branch: string;
  /** S: the branch head in the worktree, which is the head the pull request should carry. */
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
  const status = await git(input.worktree, ["status", "--porcelain"], gitExec);
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
  if (input.isCancelled?.()) return { kind: "stopped", result: cancelled(branch) };
  const token = await operationToken(input, "merge");
  input.onCredential?.("merge", token);
  const url = input.remoteUrl ?? githubHttpsUrl(input.owner, input.repo);
  await fetchMain(input.worktree, url, token, gitExec, input.sleep);
  const base = await git(input.worktree, ["rev-parse", UPSTREAM_MAIN_REF], gitExec);
  const head = await git(input.worktree, ["rev-parse", "HEAD"], gitExec);
  const containsMain = await git(
    input.worktree,
    ["merge-base", "--is-ancestor", UPSTREAM_MAIN_REF, "HEAD"],
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
    : await mainOverlap(input.worktree, input.overlap?.packages ?? [], gitExec);
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
  if (input.isCancelled?.()) return { rebased: false, result: cancelled(branch) };
  const url = input.remoteUrl ?? githubHttpsUrl(input.owner, input.repo);
  const pushed = await pushRebased(input, url, branch, input.gitExec ?? defaultGitExec());
  if (!pushed.ok) return { rebased: false, result: pushed.result };
  return { rebased: true, branch, base: pushed.base, head: pushed.head };
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
  if (input.isCancelled?.()) return cancelled(branch);
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
  if (input.isCancelled?.()) return cancelled(branch);
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
  if (merged.status !== 200 || !isRecord(merged.body) || merged.body.merged !== true)
    return {
      merged: false,
      outcome: "merge_denied",
      branch,
      head: expectedHead,
      summary,
      message: `merge failed with status ${merged.status}`,
    };
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
  input.beforeMergeCall?.(head);
  try {
    return await input.client.request(request);
  } catch (error) {
    // Cancellation belongs to the owner. It must retain the marker and propagate normally.
    if (input.isCancelled?.() || (error instanceof Error && error.name === "AbortError"))
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
