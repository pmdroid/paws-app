import type {
  MergePullRequest,
  MergeResult,
  OpenPullRequest,
  PullRequestRef,
  PullRequests,
} from "./app";
import { branchForIssue, githubHttpsUrl, pullRequestBody } from "./branch";
import { repoApiPath } from "./client";
import { defaultGitExec, git, redact, withCredential } from "./git";
import { mintInstallationToken, splitRepository } from "./token";
import {
  GitCommandError,
  type GitExec,
  type GitHubClient,
  type OpenedPull,
  type PublishResult,
} from "./types";

export async function pushBranch(input: {
  worktree: string;
  issue: string;
  owner: string;
  repo: string;
  appId: string;
  installationId: string;
  privateKeyPem: string;
  client: GitHubClient;
  remoteUrl?: string;
  now?: Date;
  gitExec?: GitExec;
}): Promise<{ branch: string; head: string }> {
  const branch = branchForIssue(input.issue);
  const url = input.remoteUrl ?? githubHttpsUrl(input.owner, input.repo);
  const gitExec = input.gitExec ?? defaultGitExec();
  const minted = await mintInstallationToken({ ...input, now: input.now });
  try {
    await withCredential(minted.token, gitExec, async (helper) => {
      try {
        await helper.exec([...helper.argsPrefix, "push", url, `HEAD:refs/heads/${branch}`], {
          cwd: input.worktree,
          env: helper.env,
        });
      } catch (error) {
        const stderr = error instanceof GitCommandError ? error.stderr : "";
        throw new Error(redact(minted.token, `push failed: ${stderr}`), { cause: error });
      }
    });
  } catch (error) {
    throw new Error(redact(minted.token, error instanceof Error ? error.message : String(error)), {
      cause: error,
    });
  }
  const head = await git(input.worktree, ["rev-parse", "HEAD"], gitExec);
  return { branch, head };
}

export async function openPullRequest(input: {
  issue: string;
  owner: string;
  repo: string;
  title?: string;
  evidence: string;
  appId: string;
  installationId: string;
  privateKeyPem: string;
  client: GitHubClient;
  now?: Date;
}): Promise<OpenedPull> {
  const branch = branchForIssue(input.issue);
  const body = pullRequestBody(input.issue, input.evidence);
  const minted = await mintInstallationToken({ ...input, now: input.now });
  const created = await input.client.request({
    method: "POST",
    path: repoApiPath(input.owner, input.repo, "/pulls"),
    token: minted.token,
    body: {
      title: input.title ?? input.issue,
      head: branch,
      base: "main",
      body,
    },
  });
  if (created.status === 201) return pullFrom(created.body, body);
  if (created.status === 422) {
    const existing = await findOpenPull(input, minted.token, branch);
    if (!existing) throw new Error("pull request already exists but could not be read");
    const patched = await input.client.request({
      method: "PATCH",
      path: repoApiPath(input.owner, input.repo, `/pulls/${existing.number}`),
      token: minted.token,
      body: { body },
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

export type PullRequestClientOptions = {
  client: GitHubClient;
  appId: string;
  installationId: string;
  privateKeyPem: string;
  now?: () => Date;
};

/**
 * Foundation seam. `open` posts the given body. `merge` is one squash guarded
 * by `expectedHeadSha`; a 409 fails closed and does not retry.
 */
export function createPullRequests(options: PullRequestClientOptions): PullRequests {
  const credentials = {
    client: options.client,
    appId: options.appId,
    installationId: options.installationId,
    privateKeyPem: options.privateKeyPem,
  };
  return {
    async open(input: OpenPullRequest): Promise<PullRequestRef> {
      const { owner, repo } = splitRepository(input.repository);
      const minted = await mintInstallationToken({
        ...credentials,
        owner,
        repo,
        ...(options.now ? { now: options.now() } : {}),
      });
      const created = await options.client.request({
        method: "POST",
        path: repoApiPath(owner, repo, "/pulls"),
        token: minted.token,
        body: {
          title: input.title,
          head: input.head,
          base: input.base,
          body: input.body,
        },
      });
      if (created.status !== 201) {
        throw new Error(`opening the pull request failed with status ${created.status}`);
      }
      const pull = pullFrom(created.body, input.body);
      return { number: pull.number, url: pull.url ?? "" };
    },
    async merge(input: MergePullRequest): Promise<MergeResult> {
      const { owner, repo } = splitRepository(input.repository);
      const minted = await mintInstallationToken({
        ...credentials,
        owner,
        repo,
        ...(options.now ? { now: options.now() } : {}),
      });
      const merged = await options.client.request({
        method: "PUT",
        path: repoApiPath(owner, repo, `/pulls/${input.number}/merge`),
        token: minted.token,
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
export async function publishAccepted(input: {
  accepted: boolean;
  evidence: string;
  worktree: string;
  issue: string;
  owner: string;
  repo: string;
  title?: string;
  appId: string;
  installationId: string;
  privateKeyPem: string;
  client: GitHubClient;
  remoteUrl?: string;
  now?: Date;
  gitExec?: GitExec;
}): Promise<PublishResult> {
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
