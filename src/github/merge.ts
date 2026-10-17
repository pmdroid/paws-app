import { existsSync } from "node:fs";
import path from "node:path";
import { acquireOperationToken } from "./auth/provider";
import type { GitHubTokenProvider } from "./auth/types";
import { branchForIssue, fixesLine, githubHttpsUrl } from "./branch";
import { repoApiPath } from "./client";
import { defaultGitExec, git, redact, withCredential } from "./git";
import { waitForMergeReadiness } from "./readiness";
import {
  GitCommandError,
  MAX_SHA_GUARD_CYCLES,
  UPSTREAM_MAIN_REF,
  type GitExec,
  type GitHubClient,
  type ReverifyInput,
  type ReverifyResult,
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
  reverify: (input: ReverifyInput) => Promise<ReverifyResult>;
  remoteUrl?: string;
  now?: () => Date;
  gitExec?: GitExec;
  /** Observability for the host. Do not log the token. */
  onCredential?: (purpose: "push" | "merge", token: string) => void;
  commitTitle?: string;
  commitMessage?: string;
  commitEnv?: Record<string, string>;
  sleep?: (ms: number) => Promise<void>;
  isCancelled?: () => boolean;
  onWait?: (message: string) => Promise<void>;
  releaseWhilePending?: boolean;
  priorVerification?: {
    base: string;
    head: string;
    summary: string;
  };
};

/**
 * Rebase onto the fetched main, re-run Closeout, and squash-merge only if
 * the verified head and base are still current. A moved SHA fails closed
 * and is verified again, up to {@link MAX_SHA_GUARD_CYCLES}.
 */
export async function serialMerge(input: SerialMergeInput): Promise<SerialMergeResult> {
  if (!Number.isInteger(input.prNumber) || input.prNumber < 1) {
    return {
      merged: false,
      outcome: "merge_denied",
      branch: safeBranch(input.branchKey ?? input.issue),
      message: "pull number is invalid",
    };
  }
  const branch = branchForIssue(input.branchKey ?? input.issue);
  const url = input.remoteUrl ?? githubHttpsUrl(input.owner, input.repo);
  const gitExec = input.gitExec ?? defaultGitExec();
  const status = await git(input.worktree, ["status", "--porcelain"], gitExec);
  if (status !== "") {
    return { merged: false, outcome: "dirty", branch, message: "worktree has uncommitted changes" };
  }

  let lastGuard: "sha" | "http_409" = "sha";
  for (let cycle = 1; cycle <= MAX_SHA_GUARD_CYCLES; cycle++) {
    if (input.isCancelled?.()) {
      return { merged: false, outcome: "blocked", branch, message: "merge cancelled" };
    }
    const pushed = await pushRebased(input, url, branch, gitExec);
    if (!pushed.ok) return { ...pushed.result, cycle };

    const verified =
      reuseVerification(input, pushed) ??
      (await input.reverify({
        worktree: input.worktree,
        base: pushed.base,
        head: pushed.head,
        cycle,
      }));
    if (!verified.accepted) {
      return {
        merged: false,
        outcome: verified.outcome,
        branch,
        base: pushed.base,
        head: pushed.head,
        summary: verified.summary,
        cycle,
      };
    }

    const readiness = await waitForMergeReadiness({
      ...input,
      head: pushed.head,
      token: () => operationToken(input, "merge"),
    });
    if (readiness.outcome === "pending") {
      return {
        merged: false,
        outcome: "waiting",
        branch,
        base: pushed.base,
        head: pushed.head,
        summary: verified.summary,
        cycle,
        message: readiness.message,
      };
    }
    if (readiness.outcome !== "ready") {
      return {
        merged: false,
        outcome: readiness.outcome,
        branch,
        base: pushed.base,
        head: pushed.head,
        cycle,
        message: readiness.message,
        ...(readiness.failedChecks ? { failedChecks: readiness.failedChecks } : {}),
      };
    }
    const mergeToken = await operationToken(input, "merge");
    input.onCredential?.("merge", mergeToken);
    const headNow = await git(input.worktree, ["rev-parse", "HEAD"], gitExec);
    await fetchMain(input.worktree, url, mergeToken, gitExec);
    const baseNow = await git(input.worktree, ["rev-parse", UPSTREAM_MAIN_REF], gitExec);
    if (headNow !== pushed.head || baseNow !== pushed.base) {
      lastGuard = "sha";
      continue;
    }

    if (input.isCancelled?.()) {
      return { merged: false, outcome: "blocked", branch, message: "merge cancelled" };
    }
    const merged = await squash(input, mergeToken, pushed.head, verified.summary);
    if (merged.status === 409) {
      lastGuard = "http_409";
      continue;
    }
    if (merged.status !== 200 || !isRecord(merged.body) || merged.body.merged !== true) {
      return {
        merged: false,
        outcome: "merge_denied",
        branch,
        base: pushed.base,
        head: pushed.head,
        summary: verified.summary,
        cycle,
        message: `merge failed with status ${merged.status}`,
      };
    }
    const sha = typeof merged.body.sha === "string" ? merged.body.sha : undefined;
    return {
      merged: true,
      outcome: "merged",
      branch,
      base: pushed.base,
      head: pushed.head,
      ...(sha ? { sha } : {}),
      summary: verified.summary,
      cycle,
    };
  }

  return {
    merged: false,
    outcome: "sha_moved",
    branch,
    message:
      lastGuard === "http_409" ? "merge API returned 409" : "head or base changed before merge",
  };
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
    await fetchMain(input.worktree, url, minted, gitExec);
    const base = await git(input.worktree, ["rev-parse", UPSTREAM_MAIN_REF], gitExec);
    const commitExec: GitExec = input.commitEnv
      ? (args, options) =>
          gitExec(args, { ...options, env: { ...options.env, ...input.commitEnv } })
      : gitExec;
    const rebase = await rebaseOnto(input.worktree, UPSTREAM_MAIN_REF, commitExec);
    if (rebase !== "ok") {
      return {
        ok: false,
        result: {
          merged: false,
          outcome: rebase === "conflict" ? "conflict" : "rebase_failed",
          branch,
          base,
          message: rebase === "conflict" ? "rebase conflict" : "rebase failed",
        },
      };
    }
    const remote = await remoteBranchSha(input.worktree, url, branch, minted, gitExec);
    await withCredential(minted, gitExec, async (helper) => {
      const args = [...helper.argsPrefix, "push"];
      if (remote) args.push(`--force-with-lease=refs/heads/${branch}:${remote}`);
      args.push(url, `HEAD:refs/heads/${branch}`);
      try {
        await helper.exec(args, { cwd: input.worktree, env: helper.env });
      } catch (error) {
        const stderr = error instanceof GitCommandError ? redact(minted, error.stderr) : "";
        throw new Error(`push rejected: ${stderr}`, { cause: error });
      }
    });
    const head = await git(input.worktree, ["rev-parse", "HEAD"], gitExec);
    return { ok: true, base, head };
  } catch (error) {
    const message = redact(minted, error instanceof Error ? error.message : String(error));
    return { ok: false, result: { merged: false, outcome: "push_rejected", branch, message } };
  }
}

async function fetchMain(
  worktree: string,
  url: string,
  token: string,
  gitExec: GitExec,
): Promise<void> {
  await withCredential(token, gitExec, async (helper) => {
    try {
      await helper.exec(
        [...helper.argsPrefix, "fetch", url, `+refs/heads/main:${UPSTREAM_MAIN_REF}`],
        { cwd: worktree, env: helper.env },
      );
    } catch (error) {
      const stderr = error instanceof GitCommandError ? redact(token, error.stderr) : "";
      throw new Error(`fetch failed: ${stderr}`, { cause: error });
    }
  });
}

async function remoteBranchSha(
  worktree: string,
  url: string,
  branch: string,
  token: string,
  gitExec: GitExec,
): Promise<string | null> {
  return withCredential(token, gitExec, async (helper) => {
    const result = await helper.exec(
      [...helper.argsPrefix, "ls-remote", url, `refs/heads/${branch}`],
      { cwd: worktree, env: helper.env },
    );
    const line = result.stdout
      .trim()
      .split("\n")
      .filter((entry) => entry !== "");
    if (line.length === 0) return null;
    if (line.length !== 1) throw new Error("ls-remote returned more than one branch");
    const sha = line[0]?.split("\t")[0];
    if (!sha) throw new Error("ls-remote returned an empty sha");
    return sha;
  });
}

async function rebaseOnto(
  worktree: string,
  onto: string,
  gitExec: GitExec,
): Promise<"ok" | "conflict" | "failed"> {
  try {
    await git(worktree, ["rebase", onto], gitExec);
    return "ok";
  } catch {
    const gitPath = await git(worktree, ["rev-parse", "--git-path", "rebase-merge"], gitExec).catch(
      () => "",
    );
    const resolved =
      gitPath === "" ? "" : path.isAbsolute(gitPath) ? gitPath : path.resolve(worktree, gitPath);
    if (resolved !== "" && existsSync(resolved)) {
      await git(worktree, ["rebase", "--abort"], gitExec).catch(() => "");
      return "conflict";
    }
    return "failed";
  }
}

async function squash(
  input: SerialMergeInput,
  token: string,
  head: string,
  summary: string,
): Promise<{ status: number; body: unknown }> {
  return input.client.request({
    method: "PUT",
    path: repoApiPath(input.owner, input.repo, `/pulls/${input.prNumber}/merge`),
    token,
    body: {
      merge_method: "squash",
      sha: head,
      commit_title: input.commitTitle ?? input.issue,
      commit_message: `${fixesLine(input.issue)}\n\n${(input.commitMessage ?? summary).trim()}\n`,
    },
  });
}

function operationToken(input: SerialMergeInput, purpose: "push" | "merge"): Promise<string> {
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

function reuseVerification(
  input: SerialMergeInput,
  pushed: { base: string; head: string },
): ReverifyResult | undefined {
  const prior = input.priorVerification;
  if (prior === undefined || prior.base !== pushed.base || prior.head !== pushed.head) {
    return undefined;
  }
  return { accepted: true, outcome: "merged", summary: prior.summary };
}

function safeBranch(issue: string): string {
  try {
    return branchForIssue(issue);
  } catch {
    return "paws/invalid";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
