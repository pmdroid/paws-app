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
  type PullRequestMember,
} from "./types";

export async function pushBranch(
  input: {
    worktree: string;
    /** The ref that names the candidate in `worktree`; `HEAD` when unset. */
    ref?: string;
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
  const ref = input.ref ?? "HEAD";
  const head = await git(input.worktree, ["rev-parse", ref], gitExec);
  try {
    await pushWithLease({
      worktree: input.worktree,
      ...(input.ref ? { ref: input.ref } : {}),
      url,
      branch,
      token,
      gitExec,
      head,
    });
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
    reviewer?: string;
    member?: PullRequestMember;
    client: GitHubClient;
  } & GitHubCredentialInput,
): Promise<OpenedPull> {
  const branch = branchForIssue(input.branchKey ?? input.issue);
  const body = publishedPullRequestBody(input);
  const token = await acquireOperationToken(input, "pr");
  const create = (as: string) =>
    input.client.request({
      method: "POST",
      path: repoApiPath(input.owner, input.repo, "/pulls"),
      token: as,
      body: {
        title: input.title ?? input.issue,
        head: branch,
        base: "main",
        body,
      },
    });
  let created = await create(input.member?.token ?? token);
  let refused: OpenedPull["memberRefused"];
  if (input.member && [401, 403, 404].includes(created.status)) {
    refused = { login: input.member.login, status: created.status };
    created = await create(token);
  }
  if (created.status === 201) {
    const pull = {
      ...pullFrom(created.body, body),
      ...(refused ? { memberRefused: refused } : {}),
    };
    const author = input.member && !refused ? input.member.login : null;
    if (input.reviewer && input.reviewer.toLowerCase() !== author?.toLowerCase())
      await input.client.request({
        method: "POST",
        path: repoApiPath(input.owner, input.repo, `/pulls/${pull.number}/requested_reviewers`),
        token,
        body: { reviewers: [input.reviewer] },
      });
    return pull;
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

export function publishedPullRequestBody(input: {
  issue: string;
  description?: string;
  evidence: string;
}): string {
  return pullRequestBody(
    input.issue,
    input.description ? `${input.description.trim()}\n\n${input.evidence}` : input.evidence,
  );
}

export async function updatePullRequestText(
  input: {
    owner: string;
    repo: string;
    number: number;
    title: string;
    body: string;
    client: GitHubClient;
    signal?: AbortSignal;
  } & GitHubCredentialInput,
): Promise<void> {
  const token = await acquireOperationToken(input, "pr");
  input.signal?.throwIfAborted();
  const patched = await input.client.request({
    method: "PATCH",
    path: repoApiPath(input.owner, input.repo, `/pulls/${input.number}`),
    token,
    body: { title: input.title, body: input.body },
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (patched.status === 200) return;
  const message =
    isRecord(patched.body) && typeof patched.body.message === "string" ? patched.body.message : "";
  throw new Error(`GitHub answered ${patched.status}${message ? `: ${message}` : ""}`);
}

export async function readPullRequestText(
  input: {
    owner: string;
    repo: string;
    number: number;
    client: GitHubClient;
    signal?: AbortSignal;
  } & GitHubCredentialInput,
): Promise<{ title: string; body: string; open: boolean }> {
  const token = await acquireOperationToken(input, "pr");
  input.signal?.throwIfAborted();
  const read = await input.client.request({
    method: "GET",
    path: repoApiPath(input.owner, input.repo, `/pulls/${input.number}`),
    token,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (read.status !== 200 || !isRecord(read.body) || typeof read.body.title !== "string")
    throw new Error(`GitHub answered ${read.status} reading pull request #${input.number}`);
  return {
    title: read.body.title,
    body: typeof read.body.body === "string" ? read.body.body.replaceAll("\r\n", "\n") : "",
    open: read.body.state === "open",
  };
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
    ref?: string;
    issue: string;
    branchKey?: string;
    owner: string;
    repo: string;
    title?: string;
    description?: string;
    reviewer?: string;
    member?: PullRequestMember;
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
