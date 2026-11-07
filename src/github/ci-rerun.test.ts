import { expect, test } from "bun:test";
import { CI_ALREADY_RERUN, CI_RERUN_PERMISSION_MISSING, rerunFailedCi } from "./ci-rerun";
import type { TokenPurpose } from "./auth";
import { GitHubTokenError, type GitHubClient } from "./types";

const head = "b".repeat(40);

type Run = {
  name?: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  started_at?: string;
  slug?: string;
};

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
              name: `job-${index + 1}`,
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

test("GitHub's 403 returns the Actions write permission message with GitHub's status", async () => {
  const github = fakeGitHub([failedRun], 403);
  const { answer, rerun: started } = await rerun(github.client);
  expect(started).toBeUndefined();
  expect(answer.startsWith(CI_RERUN_PERMISSION_MISSING)).toBe(true);
  expect(answer).toContain("GitHub refused the re-run of workflow run");
  expect(answer).toContain("with status 403");
});

test("an App without Actions write cannot mint the token and gets the permission message", async () => {
  const github = fakeGitHub([failedRun]);
  const result = await rerun(github.client, {
    tokenFor: async (purpose) => {
      if (purpose === "ci_rerun")
        throw new GitHubTokenError("installation token request failed with status 422", {
          status: 422,
          body: { message: "The permissions requested are not granted to this installation." },
        });
      return "token-merge";
    },
  });
  expect(result.rerun).toBeUndefined();
  expect(result.answer).toBe(
    `${CI_RERUN_PERMISSION_MISSING}. GitHub refused the Actions token with status 422: The permissions requested are not granted to this installation. If the App already has Actions write, accept its updated permissions on the installation.`,
  );
});

test("a cancelled run that a newer run of the same check replaced is not re-run", async () => {
  const actions = (runId: number) =>
    `https://github.com/acme/monorepo/actions/runs/${runId}/job/${runId + 1}`;
  const github = fakeGitHub([
    {
      name: "PR title type",
      status: "completed",
      conclusion: "cancelled",
      html_url: actions(42088086452),
      started_at: "2026-11-05T19:00:00Z",
    },
    {
      name: "PR title type",
      status: "completed",
      conclusion: "success",
      html_url: actions(42088104327),
      started_at: "2026-11-05T19:02:00Z",
    },
    {
      name: "Linear task linked",
      status: "completed",
      conclusion: "cancelled",
      html_url: actions(42088086445),
      started_at: "2026-11-05T19:00:00Z",
    },
  ]);
  const result = await rerun(github.client);
  expect(result.rerun).toEqual({ head, runIds: [42088086445] });
  const replaced = fakeGitHub([
    {
      name: "PR title type",
      status: "completed",
      conclusion: "cancelled",
      html_url: actions(42088086452),
      started_at: "2026-11-05T19:00:00Z",
    },
    {
      name: "PR title type",
      status: "completed",
      conclusion: "success",
      html_url: actions(42088104327),
      started_at: "2026-11-05T19:02:00Z",
    },
  ]);
  expect((await rerun(replaced.client)).answer).toContain("No GitHub Actions job failed");
  expect(replaced.requests.some((request) => request.method === "POST")).toBe(false);
});
