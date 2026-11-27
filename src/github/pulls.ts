import { acquireOperationToken } from "./auth/provider";
import type { GitHubCredentialInput } from "./auth/types";
import { journalCaught } from "../journal";
import { branchForIssue, githubHttpsUrl, pullRequestBody } from "./branch";
import { repoApiPath } from "./client";
import { memberOwnsChangedPath } from "./codeowners";
import { defaultGitExec, git, gitFailureReason, redact } from "./git";
import { moveBranchToCandidate } from "./publication";
import { pushDenial, pushWithLease } from "./push";
import {
  BranchMovedError,
  GitCommandError,
  NothingToPublishError,
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
    candidate?: string;
    expected: string | null;
    client?: GitHubClient;
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
  if (input.candidate !== undefined) {
    if (!input.client) throw new Error("push failed: publishing a stored candidate needs GitHub");
    await moveBranchToCandidate({
      client: input.client,
      owner: input.owner,
      repo: input.repo,
      branch,
      sha: input.candidate,
      expected: input.expected,
      token,
    }).catch((error: unknown) => {
      if (error instanceof BranchMovedError) throw error;
      throw new Error(`push failed: ${gitFailureReason(token, error)}`, { cause: error });
    });
    return { branch, head: input.candidate };
  }
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
      expected: input.expected,
    });
  } catch (error) {
    if (error instanceof BranchMovedError) throw error;
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
    head?: string;
    client: GitHubClient;
  } & GitHubCredentialInput,
): Promise<OpenedPull> {
  const branch = branchForIssue(input.branchKey ?? input.issue);
  const token = await acquireOperationToken(input, "pr");
  const approval = input.member ? await memberApproval(input, input.member, token) : null;
  const member = approval ? undefined : input.member;
  const login = input.member?.login;
  const opened = (line: string | null) => {
    const evidence = withOpenedBy(input.evidence, line);
    return { evidence, body: publishedPullRequestBody({ ...input, evidence }) };
  };
  let text = opened(
    approval
      ? `Opened by the Paws GitHub App: @${login} ${approval} and must approve it.`
      : member
        ? `Opened by @${login}, who delegated it.`
        : null,
  );
  const create = (as: string, body: string) =>
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
  let created = await create(member?.token ?? token, text.body);
  let refused: OpenedPull["memberRefused"];
  if (member && [401, 403, 404].includes(created.status)) {
    refused = { login: member.login, status: created.status };
    text = opened(`Opened by the Paws GitHub App: GitHub refused @${member.login}'s token.`);
    created = await create(token, text.body);
  }
  const body = text.body;
  const shown = text.evidence === input.evidence ? {} : { evidence: text.evidence };
  if (created.status === 201) {
    const pull = {
      ...pullFrom(created.body, body),
      ...shown,
      ...(refused ? { memberRefused: refused } : {}),
    };
    const author = member && !refused ? member.login : null;
    if (input.reviewer && input.reviewer.toLowerCase() !== author?.toLowerCase())
      await input.client.request({
        method: "POST",
        path: repoApiPath(input.owner, input.repo, `/pulls/${pull.number}/requested_reviewers`),
        token,
        body: { reviewers: [input.reviewer] },
      });
    return pull;
  }
  const refusal = created.status === 422 ? validationMessage(created.body) : "";
  if (/no commits between/i.test(refusal)) throw new NothingToPublishError(branch, refusal);
  if (created.status === 422 && !/pull request already exists/i.test(refusal))
    throw new Error(`opening the pull request failed: ${refusal || "GitHub answered 422"}`);
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
    return { ...pullFrom(patched.body, body), ...shown };
  }
  throw new Error(`opening the pull request failed with status ${created.status}`);
}

async function memberApproval(
  input: {
    issue: string;
    owner: string;
    repo: string;
    reviewer?: string;
    head?: string;
    client: GitHubClient;
  },
  member: PullRequestMember,
  token: string,
): Promise<string | null> {
  if (input.reviewer?.toLowerCase() === member.login.toLowerCase())
    return "is the requested reviewer";
  if (!input.head) return null;
  const owns = await memberOwnsChangedPath({
    ...input,
    head: input.head,
    token,
    login: member.login,
  }).catch((error: unknown) => {
    journalCaught(error, "github.openPullRequest.codeowners", input.issue, "opening as the member");
    return false;
  });
  return owns ? "owns a changed path in CODEOWNERS" : null;
}

function withOpenedBy(evidence: string, line: string | null): string {
  if (!line) return evidence;
  const paragraphs = evidence.split("\n\n");
  const credit = paragraphs.findIndex((paragraph) => paragraph.startsWith("Credit:"));
  if (credit < 0) return [evidence, line].filter(Boolean).join("\n\n");
  paragraphs[credit] = `${paragraphs[credit]}\n${line}`;
  return paragraphs.join("\n\n");
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
    candidate?: string;
    expected: string | null;
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
  const pull = await openPullRequest({ ...input, head: pushed.head });
  return { published: true, branch: pushed.branch, head: pushed.head, pull };
}

function validationMessage(body: unknown): string {
  if (!isRecord(body)) return "";
  const errors = Array.isArray(body.errors) ? body.errors : [];
  const details = errors.flatMap((entry) =>
    isRecord(entry) && typeof entry.message === "string" ? [entry.message] : [],
  );
  if (details.length > 0) return details.join("; ");
  return typeof body.message === "string" ? body.message : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
