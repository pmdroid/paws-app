import { expect, test } from "bun:test";
import { CI_ALREADY_RERUN, CI_RERUN_PERMISSION_MISSING, rerunFailedCi } from "./ci-rerun";
import type { TokenPurpose } from "./auth";
import { GitHubTokenError, type GitHubClient } from "./types";

const head = "b".repeat(40);

type Run = { status: string; conclusion: string | null; html_url: string; slug?: string };

const failedRun: Run = {
  status: "completed",
  conclusion: "failure",
  html_url: "https://github.com/owner/repo/actions/runs/41474224082/job/1",
};

function fakeGitHub(runs: Run[], rerunStatus = 201) {
  const requests: Array<{ method: string; path: string; token: string }> = [];
  const client: GitHubClient = {
    async request(request) {
      requests.push({ method: request.method, path: request.path, token: request.token });
      if (request.path === "/repos/owner/repo/pulls/7")
        return { status: 200, body: { state: "open", head: { sha: head } } };
      if (request.path.startsWith(`/repos/owner/repo/commits/${head}/check-runs`))
        return {
          status: 200,
          body: {
            check_runs: runs.map((run, index) => ({
              id: index + 1,
              ...run,
              app: { slug: run.slug ?? "github-actions" },
            })),
          },
        };
      if (request.method === "POST" && request.path.endsWith("/rerun-failed-jobs"))
        return { status: rerunStatus, body: {} };
      throw new Error(`unexpected request ${request.method} ${request.path}`);
    },
  };
  return { client, requests };
}

function rerun(
  client: GitHubClient,
  options: {
    alreadyRerun?: (head: string) => boolean;
    tokenFor?: (purpose: TokenPurpose) => Promise<string>;
  } = {},
) {
  return rerunFailedCi({
    client,
    owner: "owner",
    repo: "repo",
    prNumber: 7,
    alreadyRerun: options.alreadyRerun ?? (() => false),
    tokenProvider: {
      mode: "token",
      tokenFor: options.tokenFor ?? (async (purpose) => `token-${purpose}`),
    },
  });
}

test("a re-run posts rerun-failed-jobs for the head commit's failed workflow run", async () => {
  const github = fakeGitHub([
    failedRun,
    { ...failedRun, conclusion: "success", html_url: failedRun.html_url.replace("/1", "/2") },
    { ...failedRun, html_url: "https://ci.example/build/9", slug: "other-ci" },
  ]);
  const result = await rerun(github.client);
  expect(result.rerun).toEqual({ head, runIds: [41474224082] });
  const posts = github.requests.filter((request) => request.method === "POST");
  expect(posts).toEqual([
    {
      method: "POST",
      path: "/repos/owner/repo/actions/runs/41474224082/rerun-failed-jobs",
      token: "token-ci_rerun",
    },
  ]);
});

test("a commit already re-run is refused before GitHub is asked again", async () => {
  const github = fakeGitHub([failedRun]);
  const result = await rerun(github.client, { alreadyRerun: (sha) => sha === head });
  expect(result).toEqual({ answer: CI_ALREADY_RERUN });
  expect(github.requests.some((request) => request.method === "POST")).toBe(false);
});

test("a call while a check on the commit still runs is refused", async () => {
  const github = fakeGitHub([failedRun, { ...failedRun, status: "in_progress", conclusion: null }]);
  const result = await rerun(github.client);
  expect(result.rerun).toBeUndefined();
  expect(result.answer).toContain("CI is still running");
  expect(github.requests.some((request) => request.method === "POST")).toBe(false);
});

test("GitHub's 403 returns the Actions write permission message", async () => {
  const github = fakeGitHub([failedRun], 403);
  expect(await rerun(github.client)).toEqual({ answer: CI_RERUN_PERMISSION_MISSING });
});

test("an App without Actions write cannot mint the token and gets the permission message", async () => {
  const github = fakeGitHub([failedRun]);
  const result = await rerun(github.client, {
    tokenFor: async (purpose) => {
      if (purpose === "ci_rerun")
        throw new GitHubTokenError("installation token request failed with status 422", {
          status: 422,
          body: {},
        });
      return "token-merge";
    },
  });
  expect(result).toEqual({ answer: CI_RERUN_PERMISSION_MISSING });
});
