import type {
  MergePullRequest,
  MergeResult,
  OpenPullRequest,
  PullRequestRef,
  PullRequests,
} from "./app";
import { acquireOperationToken } from "./auth/provider";
import { applyPawsLabel, withPawsEvidenceMarker } from "./auth/pr";
import type { GitHubCredentialInput, GitHubTokenProvider } from "./auth/types";
import { branchForIssue, githubHttpsUrl, pullRequestBody } from "./branch";
import { repoApiPath } from "./client";
import { defaultGitExec, git, redact, withCredential } from "./git";
import { splitRepository } from "./token";
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
    owner: string;
    repo: string;
    remoteUrl?: string;
    gitExec?: GitExec;
  } & GitHubCredentialInput,
): Promise<{ branch: string; head: string }> {
  const branch = branchForIssue(branchKey(input.issue));
  const url = input.remoteUrl ?? githubHttpsUrl(input.owner, input.repo);
  const gitExec = input.gitExec ?? defaultGitExec();
  const token = await acquireOperationToken(input, "push");
  try {
    await withCredential(token, gitExec, async (helper) => {
      try {
        await helper.exec([...helper.argsPrefix, "push", url, `HEAD:refs/heads/${branch}`], {
          cwd: input.worktree,
          env: helper.env,
        });
      } catch (error) {
        const stderr = error instanceof GitCommandError ? error.stderr : "";
        throw new Error(redact(token, `push failed: ${stderr}`), { cause: error });
      }
    });
  } catch (error) {
    throw new Error(redact(token, error instanceof Error ? error.message : String(error)), {
      cause: error,
    });
  }
  const head = await git(input.worktree, ["rev-parse", "HEAD"], gitExec);
  return { branch, head };
}

export async function openPullRequest(
  input: {
    issue: string;
    owner: string;
    repo: string;
    title?: string;
    evidence: string;
    client: GitHubClient;
  } & GitHubCredentialInput,
): Promise<OpenedPull> {
  const branch = branchForIssue(branchKey(input.issue));
  const body = developerBody(
    input.tokenProvider,
    closingBody(input.issue, input.owner, input.repo, input.evidence),
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
    const pull = pullFrom(created.body, body);
    await labelIfDeveloper(input.tokenProvider, input.client, input.owner, input.repo, pull, token);
    return pull;
  }
  if (created.status === 422) {
    const existing = await findOpenPull(input, token, branch);
    if (!existing) throw new Error("pull request already exists but could not be read");
    const patched = await input.client.request({
      method: "PATCH",
      path: repoApiPath(input.owner, input.repo, `/pulls/${existing.number}`),
      token,
      body: { body },
    });
    if (patched.status !== 200)
      throw new Error(`pull request update failed with status ${patched.status}`);
    const pull = pullFrom(patched.body, body);
    await labelIfDeveloper(input.tokenProvider, input.client, input.owner, input.repo, pull, token);
    return pull;
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

export type PullRequestClientOptions = {
  client: GitHubClient;
  now?: () => Date;
} & (
  | {
      tokenProvider?: undefined;
      appId: string;
      installationId: string;
      privateKeyPem: string;
    }
  | {
      tokenProvider: GitHubTokenProvider;
      appId?: string;
      installationId?: string;
      privateKeyPem?: string;
    }
);

/**
 * Foundation seam. `open` posts the given body. `merge` is one squash guarded
 * by `expectedHeadSha`; a 409 fails closed and does not retry.
 * `github.auth = "gh"` adds the paws label and evidence marker. `"app"` mints
 * an installation token and leaves the body unchanged.
 */
export function createPullRequests(options: PullRequestClientOptions): PullRequests {
  return {
    async open(input: OpenPullRequest): Promise<PullRequestRef> {
      const { owner, repo } = splitRepository(input.repository);
      const token = await acquireOperationToken(
        {
          tokenProvider: options.tokenProvider,
          client: options.client,
          appId: options.appId,
          installationId: options.installationId,
          privateKeyPem: options.privateKeyPem,
          owner,
          repo,
          ...(options.now ? { now: options.now() } : {}),
        },
        "pr",
      );
      const body = developerBody(options.tokenProvider, input.body);
      const created = await options.client.request({
        method: "POST",
        path: repoApiPath(owner, repo, "/pulls"),
        token,
        body: {
          title: input.title,
          head: input.head,
          base: input.base,
          body,
        },
      });
      if (created.status !== 201) {
        throw new Error(`opening the pull request failed with status ${created.status}`);
      }
      const pull = pullFrom(created.body, body);
      await labelIfDeveloper(options.tokenProvider, options.client, owner, repo, pull, token);
      return { number: pull.number, url: pull.url ?? "" };
    },
    async merge(input: MergePullRequest): Promise<MergeResult> {
      const { owner, repo } = splitRepository(input.repository);
      const token = await acquireOperationToken(
        {
          tokenProvider: options.tokenProvider,
          client: options.client,
          appId: options.appId,
          installationId: options.installationId,
          privateKeyPem: options.privateKeyPem,
          owner,
          repo,
          ...(options.now ? { now: options.now() } : {}),
        },
        "merge",
      );
      const merged = await options.client.request({
        method: "PUT",
        path: repoApiPath(owner, repo, `/pulls/${input.number}/merge`),
        token,
        body: {
          merge_method: "squash",
          sha: input.expectedHeadSha,
        },
      });
      if (merged.status !== 200) {
        return { merged: false, sha: input.expectedHeadSha };
      }
      const sha =
        isRecord(merged.body) && typeof merged.body.sha === "string"
          ? merged.body.sha
          : input.expectedHeadSha;
      return { merged: isRecord(merged.body) && merged.body.merged === true, sha };
    },
  };
}

/** Push `paws/<issue>` and open the PR only after Closeout has accepted. */
export async function publishAccepted(
  input: {
    accepted: boolean;
    evidence: string;
    worktree: string;
    issue: string;
    owner: string;
    repo: string;
    title?: string;
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

const GITHUB_TRACKER_ID = /^github:([^/\s#]+)\/([^/\s#]+)#([1-9]\d*)$/;

/** `github:owner/repo#n` is a GitHub issue. Anything else stays a Linear issue key. */
function parseGitHubTrackerId(
  issue: string,
): { owner: string; repo: string; number: number } | null {
  const match = GITHUB_TRACKER_ID.exec(issue);
  if (match === null) return null;
  const owner = match[1];
  const repo = match[2];
  const raw = match[3];
  if (owner === undefined || repo === undefined || raw === undefined) return null;
  const number = Number(raw);
  if (!Number.isInteger(number) || number < 1) return null;
  return { owner, repo, number };
}

/** Branch keys stay inside `branchForIssue`. GitHub tracker ids are not valid keys. */
function branchKey(issue: string): string {
  const parsed = parseGitHubTrackerId(issue);
  if (parsed === null) return issue;
  const suffix = `-${parsed.number}`;
  const prefix = "gh-";
  const budget = 81 - prefix.length - suffix.length;
  let slug = `${parsed.owner}-${parsed.repo}`;
  if (slug.length > budget) slug = slug.slice(0, budget).replace(/[._-]+$/g, "");
  if (slug.length === 0) slug = "issue";
  const key = `${prefix}${slug}${suffix}`;
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,80}$/.test(key)) {
    throw new Error(`invalid issue key: ${issue}`);
  }
  return key;
}

/**
 * Linear issues keep `Fixes KEY`. A GitHub-sourced item closes that issue:
 * `Closes #n` in the same repo, otherwise `Closes owner/repo#n`.
 */
function closingBody(issue: string, owner: string, repo: string, evidence: string): string {
  const parsed = parseGitHubTrackerId(issue);
  if (parsed === null) return pullRequestBody(issue, evidence);
  const line =
    parsed.owner === owner && parsed.repo === repo
      ? `Closes #${parsed.number}`
      : `Closes ${parsed.owner}/${parsed.repo}#${parsed.number}`;
  const body = evidence.trim();
  return body === "" ? `${line}\n` : `${line}\n\n${body}\n`;
}

function developerBody(provider: GitHubTokenProvider | undefined, body: string): string {
  return provider?.mode === "gh" ? withPawsEvidenceMarker(body) : body;
}

async function labelIfDeveloper(
  provider: GitHubTokenProvider | undefined,
  client: GitHubClient,
  owner: string,
  repo: string,
  pull: OpenedPull,
  token: string,
): Promise<void> {
  if (provider?.mode !== "gh") return;
  await applyPawsLabel({ client, owner, repo, number: pull.number, token });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
