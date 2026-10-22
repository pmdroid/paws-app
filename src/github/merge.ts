import { existsSync } from "node:fs";
import path from "node:path";
import { acquireOperationToken } from "./auth/provider";
import type { GitHubTokenProvider } from "./auth/types";
import { branchForIssue, fixesLine, githubHttpsUrl } from "./branch";
import { repoApiPath } from "./client";
import { defaultGitExec, git, redact, withCredential } from "./git";
import { mainOverlap, readUpToDateRule } from "./overlap";
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
  /**
   * Update the branch only when main changed the same files or package (PAS-394). Otherwise the
   * pull request's head merges on its own green CI. GitHub's "Require branches to be up to date"
   * rule turns this off for the pass.
   */
  updateOnOverlap?: {
    /** Package roots such as `apps/*`. Without them, only the same file overlaps. */
    packages: readonly string[];
    /** Called with each read of the rule. `true` means the branch is updated anyway. */
    onUpToDateRule?: (required: boolean) => Promise<void>;
  };
};

type Pushed = { base: string; head: string; kept?: boolean; overlap?: string[] };

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
  // Turned off by GitHub's up-to-date rule, or when GitHub refuses the head without an update.
  let keepWhenApart = input.updateOnOverlap !== undefined;
  let rule: boolean | null | undefined;
  for (let cycle = 1; cycle <= MAX_SHA_GUARD_CYCLES; cycle++) {
    if (input.isCancelled?.()) {
      return { merged: false, outcome: "blocked", branch, message: "merge cancelled" };
    }
    let pushed: Pushed | undefined;
    let overlap: string[] | undefined;
    if (keepWhenApart) {
      const apart = await keepHead(input, url, branch, gitExec, async (token) => {
        if (rule === undefined) {
          rule = await readUpToDateRule({ ...input, token, branch: "main" }).catch(() => null);
          if (rule !== null) await input.updateOnOverlap?.onUpToDateRule?.(rule);
        }
        return rule === true;
      });
      if ("kept" in apart) pushed = apart.kept;
      else {
        overlap = apart.overlap;
        if (apart.ruleOn) keepWhenApart = false;
      }
    }
    if (pushed === undefined) {
      const rebased = await pushRebased(input, url, branch, gitExec);
      if (!rebased.ok) return { ...rebased.result, cycle };
      pushed = { base: rebased.base, head: rebased.head, ...(overlap ? { overlap } : {}) };
    }

    const verified =
      reuseVerification(input, pushed) ??
      (await input.reverify({
        worktree: input.worktree,
        base: pushed.base,
        head: pushed.head,
        cycle,
        ...(pushed.kept ? { kept: true } : {}),
        ...(pushed.overlap?.length ? { overlap: pushed.overlap } : {}),
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
      // A kept head still merges if main's newer changes stay apart from it too.
      const apart =
        pushed.kept === true &&
        headNow === pushed.head &&
        (await mainOverlap(input.worktree, input.updateOnOverlap?.packages ?? [], gitExec)).shared
          .length === 0;
      if (!apart) {
        lastGuard = "sha";
        continue;
      }
      pushed = { ...pushed, base: baseNow };
    }

    if (input.isCancelled?.()) {
      return { merged: false, outcome: "blocked", branch, message: "merge cancelled" };
    }
    // Checks can change while the base is fetched. Read them once more; the
    // merge call also carries the head SHA so GitHub refuses a moved head.
    const recheck = await waitForMergeReadiness({
      ...input,
      head: pushed.head,
      token: async () => mergeToken,
      releaseWhilePending: true,
    });
    if (recheck.outcome === "sha_moved") {
      lastGuard = "sha";
      continue;
    }
    if (recheck.outcome !== "ready") {
      return {
        merged: false,
        outcome: recheck.outcome === "pending" ? "waiting" : recheck.outcome,
        branch,
        base: pushed.base,
        head: pushed.head,
        ...(recheck.outcome === "pending" ? { summary: verified.summary } : {}),
        cycle,
        message: recheck.message,
        ...(recheck.failedChecks ? { failedChecks: recheck.failedChecks } : {}),
      };
    }
    // A stop or withdrawn publication during the recheck must still win.
    if (input.isCancelled?.()) {
      return { merged: false, outcome: "blocked", branch, message: "merge cancelled" };
    }
    const merged = await squash(input, mergeToken, pushed.head, verified.summary);
    if (merged.status === 409) {
      lastGuard = "http_409";
      continue;
    }
    if (pushed.kept && (merged.status !== 200 || !isRecord(merged.body) || !merged.body.merged)) {
      // GitHub refused the head without an update: update the branch and wait for CI instead.
      keepWhenApart = false;
      lastGuard = "sha";
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

/**
 * Fetch main and keep the pull request's head when main's changes since its base don't overlap
 * it. Otherwise say what overlapped, or that GitHub's up-to-date rule is on.
 */
async function keepHead(
  input: SerialMergeInput,
  url: string,
  branch: string,
  gitExec: GitExec,
  upToDateRule: (token: string) => Promise<boolean>,
): Promise<{ kept: Pushed } | { overlap?: string[]; ruleOn?: true }> {
  const minted = await operationToken(input, "push");
  input.onCredential?.("push", minted);
  try {
    await fetchMain(input.worktree, url, minted, gitExec);
    const base = await git(input.worktree, ["rev-parse", UPSTREAM_MAIN_REF], gitExec);
    const head = await git(input.worktree, ["rev-parse", "HEAD"], gitExec);
    const compared = await mainOverlap(
      input.worktree,
      input.updateOnOverlap?.packages ?? [],
      gitExec,
    );
    // Main has not moved past the branch: the usual pass changes nothing.
    if (compared.base === base) return {};
    if (compared.shared.length > 0) return { overlap: compared.shared };
    if (await upToDateRule(minted)) return { ruleOn: true };
    // Only the head GitHub already has, and its CI, can merge without an update.
    if ((await remoteBranchSha(input.worktree, url, branch, minted, gitExec)) !== head) return {};
    return { kept: { base, head, kept: true } };
  } catch {
    // The usual pass reports a fetch or git failure.
    return {};
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

function reuseVerification(input: SerialMergeInput, pushed: Pushed): ReverifyResult | undefined {
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
