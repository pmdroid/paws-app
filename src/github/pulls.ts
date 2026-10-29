import { acquireOperationToken } from "./auth/provider";
import type { GitHubCredentialInput } from "./auth/types";
import { branchForIssue, githubHttpsUrl, pullRequestBody } from "./branch";
import { repoApiPath } from "./client";
import { defaultGitExec, git, gitFailureReason, redact } from "./git";
import { pushDenial, pushWithLease } from "./push";
import {
  GitCommandError,
  type GitExec,
  type GitHubClient,
  type OpenedPull,
  type PublishResult,
} from "./types";

export async function pushBranch(
  input: {
    worktree: string;
    issue: string;
    branchKey?: string;
    owner: string;
    repo: string;
    remoteUrl?: string;
    gitExec?: GitExec;
  } & GitHubCredentialInput,
): Promise<{ branch: string; head: string }> {
  const branch = branchForIssue(input.branchKey ?? input.issue);
  const url = input.remoteUrl ?? githubHttpsUrl(input.owner, input.repo);
  const gitExec = input.gitExec ?? defaultGitExec();
  const token = await acquireOperationToken(input, "push");
  try {
    await pushWithLease({ worktree: input.worktree, url, branch, token, gitExec });
  } catch (error) {
    const denial =
      error instanceof GitCommandError
        ? pushDenial(redact(token, error.stderr), {
            owner: input.owner,
            repo: input.repo,
            ...(input.installationId ? { installationId: input.installationId } : {}),
          })
        : null;
    throw new Error(`push failed: ${denial ?? gitFailureReason(token, error)}`, { cause: error });
  }
  const head = await git(input.worktree, ["rev-parse", "HEAD"], gitExec);
  return { branch, head };
}

export async function openPullRequest(
  input: {
    issue: string;
    branchKey?: string;
    owner: string;
    repo: string;
    title?: string;
    description?: string;
    evidence: string;
    client: GitHubClient;
  } & GitHubCredentialInput,
): Promise<OpenedPull> {
  const branch = branchForIssue(input.branchKey ?? input.issue);
  const body = pullRequestBody(
    input.issue,
    input.description ? `${input.description.trim()}\n\n${input.evidence}` : input.evidence,
  );
  const token = await acquireOperationToken(input, "pr");
  const created = await input.client.request({
    method: "POST",
    path: repoApiPath(input.owner, input.repo, "/pulls"),
    token,
    body: {
      title: input.title ?? input.issue,
      head: branch,
      base: "main",
      body,
    },
  });
  if (created.status === 201) {
    return pullFrom(created.body, body);
  }
  if (created.status === 422) {
    const existing = await findOpenPull(input, token, branch);
    if (!existing) throw new Error("pull request already exists but could not be read");
    const patched = await input.client.request({
      method: "PATCH",
      path: repoApiPath(input.owner, input.repo, `/pulls/${existing.number}`),
      token,
      body: input.title ? { title: input.title, body } : { body },
    });
    if (patched.status !== 200)
      throw new Error(`pull request update failed with status ${patched.status}`);
    return pullFrom(patched.body, body);
  }
  throw new Error(`opening the pull request failed with status ${created.status}`);
}

async function findOpenPull(
  input: { owner: string; repo: string; client: GitHubClient },
  token: string,
  branch: string,
): Promise<{ number: number } | null> {
  const listed = await input.client.request({
    method: "GET",
    path: `${repoApiPath(input.owner, input.repo, "/pulls")}?head=${encodeURIComponent(`${input.owner}:${branch}`)}&state=open`,
    token,
  });
  if (listed.status !== 200 || !Array.isArray(listed.body)) return null;
  const first = listed.body[0];
  if (!isRecord(first) || typeof first.number !== "number") return null;
  return { number: first.number };
}

function pullFrom(body: unknown, fallbackBody: string): OpenedPull {
  if (
    !isRecord(body) ||
    typeof body.number !== "number" ||
    !Number.isInteger(body.number) ||
    body.number < 1
  ) {
    throw new Error("pull request response has no number");
  }
  return {
    number: body.number,
    url: typeof body.html_url === "string" ? body.html_url : null,
    body: typeof body.body === "string" ? body.body : fallbackBody,
  };
}

/** Push `paws/<issue>` and open the PR only after Closeout has accepted. */
export async function publishAccepted(
  input: {
    accepted: boolean;
    evidence: string;
    worktree: string;
    issue: string;
    branchKey?: string;
    owner: string;
    repo: string;
    title?: string;
    description?: string;
    remoteUrl?: string;
    gitExec?: GitExec;
    client: GitHubClient;
  } & GitHubCredentialInput,
): Promise<PublishResult> {
  if (!input.accepted) {
    return { published: false, reason: "closeout did not accept" };
  }
  const pushed = await pushBranch(input);
  const pull = await openPullRequest(input);
  return { published: true, branch: pushed.branch, head: pushed.head, pull };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
