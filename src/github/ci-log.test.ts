import { generateKeyPairSync } from "node:crypto";
import { expect, test } from "bun:test";
import { CI_LOG_MAX_BYTES, readCiLog, reduceCiLog } from "./ci-log";
import type { TokenPurpose } from "./auth";
import { GitHubTokenError, type GitHubClient } from "./types";

const head = "a".repeat(40);
const token = "ghs_syntheticInstallationToken";

const checkRuns = [
  {
    id: 101,
    name: "test",
    conclusion: "failure",
    html_url: "https://github.com/owner/repo/actions/runs/9/job/101?check_suite_focus=true",
    app: { slug: "github-actions" },
  },
  {
    id: 102,
    name: "lint",
    conclusion: "success",
    html_url: "https://github.com/owner/repo/actions/runs/9/job/102",
    app: { slug: "github-actions" },
  },
  {
    id: 103,
    name: "build",
    conclusion: "timed_out",
    html_url: `https://x-access-token:${token}@github.com/owner/repo/actions/runs/9/job/103`,
    app: { slug: "github-actions" },
  },
];

function fakeGitHub(log: string, logStatus = 200) {
  const requests: Array<{ path: string; token: string }> = [];
  const client: GitHubClient = {
    async request(request) {
      requests.push({ path: request.path, token: request.token });
      if (request.path === "/repos/owner/repo/pulls/7")
        return { status: 200, body: { state: "open", head: { sha: head } } };
      if (request.path.startsWith(`/repos/owner/repo/commits/${head}/check-runs`))
        return { status: 200, body: { total_count: 3, check_runs: checkRuns } };
      if (request.path === "/repos/owner/repo/actions/jobs/101/logs") {
        expect(request.accept).toBe("text");
        return { status: logStatus, body: log };
      }
      throw new Error(`unexpected request ${request.path}`);
    },
  };
  return { client, requests };
}

function read(
  client: GitHubClient,
  job?: string,
  tokenFor: (purpose: TokenPurpose) => Promise<string> = async () => token,
) {
  return readCiLog({
    client,
    owner: "owner",
    repo: "repo",
    prNumber: 7,
    job,
    tokenProvider: { mode: "token", tokenFor },
  });
}

test("the job log is read with an Actions log token, the checks with the merge token", async () => {
  const github = fakeGitHub("##[error]boom");
  const purposes: TokenPurpose[] = [];
  await read(github.client, "test", async (purpose) => {
    purposes.push(purpose);
    return `${token}-${purpose}`;
  });
  expect(purposes).toEqual(["merge", "ci_log"]);
  expect(github.requests.map((request) => request.token)).toEqual([
    `${token}-merge`,
    `${token}-merge`,
    `${token}-ci_log`,
  ]);
});

test("an App without Actions read says which permission to grant", async () => {
  const message = /needs the Actions: Read-only permission/;
  const refused = async () => {
    throw new GitHubTokenError("installation token request failed with status 422", {
      status: 422,
      body: {},
    });
  };
  await expect(
    read(fakeGitHub("").client, "test", async (purpose) =>
      purpose === "ci_log" ? refused() : token,
    ),
  ).rejects.toThrow(message);
  await expect(read(fakeGitHub("", 403).client, "test")).rejects.toThrow(message);
});

test("lists the failed check runs on the pull request's head commit", async () => {
  const github = fakeGitHub("");
  const answer = await read(github.client);
  expect(JSON.parse(answer)).toEqual({
    head,
    failed: [
      {
        name: "test",
        conclusion: "failure",
        job: 101,
        url: "https://github.com/owner/repo/actions/runs/9/job/101",
      },
      { name: "build", conclusion: "timed_out", job: 103, url: null },
    ],
  });
  expect(answer).not.toContain(token);
  expect(github.requests.every((request) => request.token === token)).toBe(true);
});

test("a job's log comes back reduced to its errors and capped at 24 KB, keeping the end", async () => {
  const noise = Array.from(
    { length: 50 },
    (_, index) => `2026-11-03T10:00:00.0000000Z noise ${index}`,
  );
  const log = [
    "##[group]Run setup",
    ...noise,
    "##[endgroup]",
    "\u001b[31m##[error]first failure\u001b[0m",
    ...noise,
    "##[error]second failure",
    "Post job cleanup.",
  ].join("\n");
  const reduced = reduceCiLog(log);
  const lines = reduced.split("\n");
  expect(lines[0]).toBe("noise 20");
  expect(lines).toContain("##[error]first failure");
  expect(lines).not.toContain("##[group]Run setup");
  expect(lines.at(-1)).toBe("##[error]second failure");
  expect(lines.filter((line) => line.startsWith("noise")).length).toBe(60);
  expect(reduced).not.toContain("2026-11-03T");

  const long = Array.from({ length: 4000 }, (_, index) => `line ${index} ${"x".repeat(20)}`);
  const capped = await read(fakeGitHub([...long, "##[error]the end"].join("\n")).client, "test");
  const body = capped.slice(capped.indexOf("\n\n") + 2);
  expect(capped.startsWith(`Log of test (job 101, failure) on ${head.slice(0, 7)}`)).toBe(true);
  expect(Buffer.byteLength(body)).toBeLessThanOrEqual(CI_LOG_MAX_BYTES);
  expect(body.endsWith("##[error]the end")).toBe(true);

  const byId = await read(fakeGitHub("##[error]boom").client, "101");
  expect(byId.endsWith("##[error]boom")).toBe(true);
});

test("a job that is not among the head commit's checks is refused", async () => {
  const github = fakeGitHub("##[error]boom");
  await expect(read(github.client, "999")).rejects.toThrow(
    `Job "999" is not one of the checks on the pull request's head ${head.slice(0, 7)}`,
  );
  await expect(read(github.client, "deploy")).rejects.toThrow("is not one of the checks");
  expect(github.requests.some((request) => request.path.includes("/actions/jobs/"))).toBe(false);
});

test("an unexpected failure reaches the agent without a URL or token", async () => {
  const client: GitHubClient = {
    async request() {
      throw new Error(`fetch https://storage.example/log?sig=${token} failed`);
    },
  };
  await expect(read(client)).rejects.toThrow(
    /^Paws could not read CI from GitHub\. Try again later\.$/,
  );
});

test("with App credentials, the job log is read with a minted Actions log token", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const github = fakeGitHub("##[error]boom");
  const asked: unknown[] = [];
  const client: GitHubClient = {
    async request(request) {
      if (!request.path.endsWith("/access_tokens")) return github.client.request(request);
      const permissions = (request.body as { permissions: Record<string, string> }).permissions;
      asked.push(permissions);
      return {
        status: 201,
        body: {
          token: permissions.actions ? "ghs_actions" : "ghs_merge",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          repository_selection: "selected",
          repositories: [{ name: "repo", full_name: "owner/repo" }],
          permissions,
        },
      };
    },
  };
  const answer = await readCiLog({
    client,
    owner: "owner",
    repo: "repo",
    prNumber: 7,
    job: "test",
    appId: "1",
    installationId: "2",
    privateKeyPem: privateKey as string,
  });
  expect(answer.endsWith("##[error]boom")).toBe(true);
  expect(asked.at(-1)).toEqual({ actions: "read", checks: "read", metadata: "read" });
  expect(github.requests.at(-1)?.token).toBe("ghs_actions");
  expect(answer).not.toContain("ghs_");
});
