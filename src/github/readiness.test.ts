import { expect, test } from "bun:test";
import { setJournalSink } from "../journal";
import { fakeMergeReadiness, fakeRequiredChecks, type FakeCheckContext } from "./fake";
import { createFetchGitHubClient } from "./client";
import { logTail, waitForMergeReadiness } from "./readiness";
import type { CiCheckState, GitHubResponse } from "./types";

const head = "a".repeat(40);

type Variables = Record<string, unknown>;

function fixture(
  reply: (variables: Variables, poll: number) => GitHubResponse,
  required: { protection?: string[]; rulesets?: string[] } = {},
) {
  let polls = 0;
  let sleeps = 0;
  const tokens: string[] = [];
  const input = {
    owner: "owner",
    repo: "repo",
    prNumber: 12,
    head,
    token: async () => `synthetic-token-${++polls}`,
    sleep: async (ms: number) => {
      expect(ms).toBe(10_000);
      sleeps++;
    },
    client: {
      async request(request: { method: string; path: string; token: string; body?: unknown }) {
        if (request.path !== "/graphql") {
          const answer = fakeRequiredChecks(request, required);
          if (!answer) throw new Error(`unexpected request ${request.path}`);
          return answer;
        }
        const variables = (request.body as { variables: Variables }).variables;
        expect(variables.head).toBe(head);
        expect(variables.number).toBe(12);
        tokens.push(request.token);
        return reply(variables, polls);
      },
    },
  };
  return { input, tokens, sleeps: () => sleeps };
}

function withChecks(checks: FakeCheckContext[], baseChecks: FakeCheckContext[] = []) {
  const body = fakeMergeReadiness(head);
  body.data.repository.object.statusCheckRollup.contexts.nodes = checks;
  body.data.repository.pullRequest.baseRef.target.statusCheckRollup.contexts.nodes = baseChecks;
  return { status: 200, body };
}

const run = (name: string, conclusion: string | null): FakeCheckContext => ({
  name,
  conclusion,
  detailsUrl: `https://ci.example/${name}`,
});

async function readOnce(
  reply: (variables: Variables, poll: number) => GitHubResponse,
  required?: { protection?: string[]; rulesets?: string[] },
) {
  const f = fixture(reply, required);
  return waitForMergeReadiness({ ...f.input, releaseWhilePending: true });
}

test("waits for both check runs and legacy statuses on the exact candidate", async () => {
  const f = fixture((_, poll) =>
    withChecks([
      run("build", poll === 1 ? null : "SUCCESS"),
      { context: "legacy", state: "SUCCESS", targetUrl: null },
    ]),
  );
  const messages: string[] = [];
  const result = await waitForMergeReadiness({
    ...f.input,
    onWait: async (message) => {
      messages.push(message);
    },
  });
  expect(result.outcome).toBe("ready");
  expect(f.sleeps()).toBe(1);
  expect(f.tokens).toEqual(["synthetic-token-1", "synthetic-token-2"]);
  expect(messages).toEqual(["Waiting for checks: build."]);
});

test("a pending legacy status keeps the pull request waiting", async () => {
  const result = await readOnce(() =>
    withChecks([run("build", "SUCCESS"), { context: "legacy", state: "PENDING" }]),
  );
  expect(result).toEqual({ outcome: "pending", message: "Waiting for checks: legacy." });
});

test("a check that registers after the others went green holds the merge until it reports", async () => {
  // Cloudflare Pages reported on the base head, so it is expected on the candidate too.
  const base = [run("build", "SUCCESS"), run("Cloudflare Pages", "SUCCESS")];
  const f = fixture((_, poll) =>
    withChecks(
      poll === 1
        ? [run("build", "SUCCESS")]
        : poll === 2
          ? [run("build", "SUCCESS"), run("Cloudflare Pages", null)]
          : [run("build", "SUCCESS"), run("Cloudflare Pages", "SUCCESS")],
      base,
    ),
  );
  const messages: string[] = [];
  const result = await waitForMergeReadiness({
    ...f.input,
    onWait: async (message) => {
      messages.push(message);
    },
  });
  expect(result.outcome).toBe("ready");
  expect(f.tokens.length).toBe(3);
  expect(messages).toEqual(["Waiting for checks: Cloudflare Pages."]);
});

for (const source of ["protection", "rulesets"] as const) {
  test(`waits for a required check from ${source} that has not reported`, async () => {
    const result = await readOnce(() => withChecks([run("build", "SUCCESS")]), {
      [source]: ["deploy preview"],
    });
    expect(result).toEqual({ outcome: "pending", message: "Waiting for checks: deploy preview." });
  });
}

test("a required check that reported green lets the merge through", async () => {
  const result = await readOnce(
    () => withChecks([run("build", "SUCCESS"), run("deploy preview", "SUCCESS")]),
    { protection: ["build"], rulesets: ["deploy preview"] },
  );
  expect(result.outcome).toBe("ready");
});

for (const conclusion of ["NEUTRAL", "STALE", "ACTION_REQUIRED"]) {
  test(`${conclusion} is not green`, async () => {
    const result = await readOnce(() =>
      withChecks([run("build", "SUCCESS"), run("lint", conclusion)]),
    );
    expect(result).toEqual({ outcome: "pending", message: "Waiting for checks: lint." });
  });
}

test("SKIPPED is green when the same check was skipped on the base head", async () => {
  const result = await readOnce(() =>
    withChecks(
      [run("build", "SUCCESS"), run("release", "SKIPPED")],
      [run("build", "SUCCESS"), run("release", "SKIPPED")],
    ),
  );
  expect(result.outcome).toBe("ready");
});

for (const [label, base] of [
  ["ran", [run("release", "SUCCESS")]],
  ["did not report", []],
] as const) {
  test(`SKIPPED is not green when the check ${label} on the base head`, async () => {
    const result = await readOnce(() =>
      withChecks([run("build", "SUCCESS"), run("release", "SKIPPED")], [...base]),
    );
    expect(result).toEqual({ outcome: "pending", message: "Waiting for checks: release." });
  });
}

test("reads every check context page past the first 100 on the head and the base", async () => {
  const seen: Variables[] = [];
  const head100 = Array.from({ length: 100 }, (_, i) => run(`check-${i}`, "SUCCESS"));
  const base100 = Array.from({ length: 100 }, (_, i) => run(`check-${i}`, "SUCCESS"));
  const result = await readOnce((variables) => {
    seen.push(variables);
    const body = fakeMergeReadiness(head);
    const checks = body.data.repository.object.statusCheckRollup.contexts;
    const base = body.data.repository.pullRequest.baseRef.target.statusCheckRollup.contexts;
    checks.nodes = variables.checksCursor === null ? head100 : [run("check-100", "FAILURE")];
    checks.pageInfo = {
      hasNextPage: variables.checksCursor === null,
      endCursor: variables.checksCursor === null ? "checks-2" : null,
    };
    base.nodes = variables.baseChecksCursor === null ? base100 : [run("late-on-base", "SUCCESS")];
    base.pageInfo = {
      hasNextPage: variables.baseChecksCursor === null,
      endCursor: variables.baseChecksCursor === null ? "base-2" : null,
    };
    return { status: 200, body };
  });
  expect(result.outcome).toBe("ci_failed");
  expect(result.failedChecks).toEqual([
    { name: "check-100", url: "https://ci.example/check-100", logTail: null, failsOnBase: false },
  ]);
  expect(result.checks).toHaveLength(101);
  expect(seen.map((v) => [v.checksCursor, v.baseChecksCursor, v.readThreads])).toEqual([
    [null, null, true],
    ["checks-2", "base-2", false],
  ]);
});

test("a check expected from the base head's second page keeps the merge waiting", async () => {
  const result = await readOnce((variables) => {
    const body = fakeMergeReadiness(head);
    const base = body.data.repository.pullRequest.baseRef.target.statusCheckRollup.contexts;
    base.nodes =
      variables.baseChecksCursor === null ? [run("ci", "SUCCESS")] : [run("e2e", "SUCCESS")];
    base.pageInfo = {
      hasNextPage: variables.baseChecksCursor === null,
      endCursor: variables.baseChecksCursor === null ? "base-2" : null,
    };
    return { status: 200, body };
  });
  expect(result).toEqual({ outcome: "pending", message: "Waiting for checks: e2e." });
});

test("a failing check fails CI with its name, even while others still run", async () => {
  for (const conclusion of ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE"]) {
    const result = await readOnce(() =>
      withChecks([
        run("build", conclusion),
        run("lint", null),
        { context: "legacy", state: "SUCCESS", targetUrl: null },
      ]),
    );
    const ci = (name: string, state: CiCheckState) => ({
      name,
      state,
      url: name === "legacy" ? null : `https://ci.example/${name}`,
      startedAt: null,
      completedAt: null,
      logTail: null,
      logSource: null,
    });
    expect(result).toEqual({
      outcome: "ci_failed",
      message: "CI failed on the candidate commit",
      failedChecks: [
        { name: "build", url: "https://ci.example/build", logTail: null, failsOnBase: false },
      ],
      checks: [ci("build", "failed"), ci("lint", "running"), ci("legacy", "passed")],
    });
  }
  const status = await readOnce(() =>
    withChecks([{ context: "legacy", state: "ERROR", targetUrl: "https://ci.example/legacy" }]),
  );
  expect(status.failedChecks).toEqual([
    { name: "legacy", url: "https://ci.example/legacy", logTail: null, failsOnBase: false },
  ]);
});

test("a failing check that also fails on the base head is marked so", async () => {
  const result = await readOnce(() =>
    withChecks(
      [run("build", "FAILURE"), run("lint", "FAILURE")],
      [run("build", "FAILURE"), run("lint", "SUCCESS")],
    ),
  );
  expect(result.failedChecks?.map((check) => [check.name, check.failsOnBase])).toEqual([
    ["build", true],
    ["lint", false],
  ]);
});

test("unreadable required checks block instead of merging", async () => {
  const f = fixture(() => withChecks([run("build", "SUCCESS")]));
  const result = await waitForMergeReadiness({
    ...f.input,
    client: {
      async request(request) {
        if (request.path.includes("/rules/branches/")) return { status: 403, body: {} };
        return f.input.client.request(request);
      },
    },
  });
  expect(result).toEqual({
    outcome: "blocked",
    message: "could not read GitHub CI and review threads",
  });
  expect(f.sleeps()).toBe(2);
});

test("reads every review thread page and waits until unresolved threads are resolved", async () => {
  const cursors: unknown[] = [];
  const f = fixture((variables, poll) => {
    const cursor = variables.threadsCursor;
    cursors.push(cursor);
    const body = fakeMergeReadiness(head);
    const threads = body.data.repository.pullRequest.reviewThreads;
    threads.nodes = [{ isResolved: cursor === null || poll > 1 }];
    threads.pageInfo = {
      hasNextPage: cursor === null,
      endCursor: cursor === null ? "page-2" : null,
    };
    return { status: 200, body };
  });
  const result = await waitForMergeReadiness(f.input);
  expect(result.outcome).toBe("ready");
  expect(cursors).toEqual([null, "page-2", null, "page-2"]);
  expect(f.tokens).toEqual([
    "synthetic-token-1",
    "synthetic-token-1",
    "synthetic-token-2",
    "synthetic-token-2",
  ]);
  expect(f.sleeps()).toBe(1);
});

for (const absent of ["rollup", "contexts"]) {
  test(`times out without merging when CI has no ${absent}`, async () => {
    const f = fixture(() => {
      const body = fakeMergeReadiness(head);
      if (absent === "rollup") {
        return {
          status: 200,
          body: {
            data: {
              repository: {
                ...body.data.repository,
                object: { oid: head, statusCheckRollup: null },
              },
            },
          },
        };
      }
      body.data.repository.object.statusCheckRollup.contexts.nodes = [];
      return { status: 200, body };
    });
    const result = await waitForMergeReadiness(f.input);
    expect(result.outcome).toBe("blocked");
    expect(result.message).toContain("timed out");
    expect(result.message).toContain("Waiting for CI on the candidate commit.");
    expect(f.tokens.length).toBe(270);
    expect(f.sleeps()).toBe(269);
  });
}

test("stops polling when cancelled while review threads remain open", async () => {
  let cancelled = false;
  const f = fixture(() => {
    const body = fakeMergeReadiness(head);
    body.data.repository.pullRequest.reviewThreads.nodes = [{ isResolved: false }];
    return { status: 200, body };
  });
  const result = await waitForMergeReadiness({
    ...f.input,
    isCancelled: () => cancelled,
    sleep: async () => {
      cancelled = true;
    },
  });
  expect(result).toEqual({ outcome: "blocked", message: "merge cancelled" });
  expect(f.tokens.length).toBe(1);
});

for (const scenario of [
  "GraphQL errors",
  "null thread",
  "repeated cursor",
  "missing cursor",
  "exception",
]) {
  test(`blocks unreadable merge gates: ${scenario}`, async () => {
    const f = fixture(() => {
      const body = fakeMergeReadiness(head);
      if (scenario === "exception") throw new Error("synthetic-token-must-not-be-logged");
      if (scenario === "GraphQL errors")
        return { status: 200, body: { ...body, errors: [{ message: "forbidden" }] } };
      if (scenario === "null thread")
        return {
          status: 200,
          body: {
            data: {
              repository: {
                ...body.data.repository,
                pullRequest: {
                  ...body.data.repository.pullRequest,
                  reviewThreads: {
                    nodes: [null],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          },
        };
      body.data.repository.pullRequest.reviewThreads.pageInfo = {
        hasNextPage: true,
        endCursor: scenario === "missing cursor" ? null : "page-2",
      };
      return { status: 200, body };
    });
    const result = await waitForMergeReadiness(f.input);
    expect(result.outcome).toBe("blocked");
    expect(result.message).not.toContain("synthetic-token");
    expect(f.sleeps()).toBe(2);
  });
}

test("a failed read right after the pull request opens is retried", async () => {
  const f = fixture((_, poll) => {
    if (poll === 1) throw new Error("GitHub GraphQL unavailable");
    return { status: 200, body: fakeMergeReadiness(head) };
  });
  const result = await waitForMergeReadiness(f.input);
  expect(result.outcome).toBe("ready");
  expect(f.sleeps()).toBe(1);
});

test("a failed read logs the error message with GitHub tokens redacted", async () => {
  const token = `ghs_${"a".repeat(36)}`;
  const f = fixture(() => {
    throw new Error(`The Linear publication was superseded. ${token}`);
  });
  const logged: string[] = [];
  const restore = setJournalSink((line) => logged.push(line));
  try {
    await waitForMergeReadiness(f.input);
  } finally {
    restore();
  }
  expect(logged[0]).toContain("The Linear publication was superseded.");
  expect(logged.join("\n")).not.toContain(token);
});

test("a Linear rate limit while minting the token waits instead of blocking the merge", async () => {
  const f = fixture(() => withChecks([run("build", "SUCCESS")]));
  let mints = 0;
  const waits: string[] = [];
  const result = await waitForMergeReadiness({
    ...f.input,
    token: async () => {
      if (++mints <= 4) throw new Error("Linear GraphQL: RATELIMITED");
      return "synthetic-token-after-reset";
    },
    onWait: async (message) => {
      waits.push(message);
    },
  });
  expect(result.outcome).toBe("ready");
  expect(waits).toEqual(["Waiting for Linear's rate limit to reset before reading GitHub."]);
});

const ACTIONS_LOG = [
  "2026-10-22T10:00:00.0000000Z ##[group]Run bun test",
  "2026-10-22T10:00:01.0000000Z bun test v1.4.2",
  "2026-10-22T10:00:01.1000000Z ##[endgroup]",
  "2026-10-22T10:00:02.0000000Z \u001b[31m✗\u001b[0m lists a draining runner's sessions",
  "2026-10-22T10:00:02.1000000Z  1 fail",
  "2026-10-22T10:00:03.0000000Z ##[error]Process completed with exit code 1.",
  "2026-10-22T10:00:04.0000000Z Post job cleanup.",
  "",
].join("\n");

test("a failing Actions check carries the tail of its job log; another falls back to its summary", async () => {
  const logReads: { path: string; token: string; accept?: string }[] = [];
  const f = fixture(() =>
    withChecks([
      {
        ...run("check / test", "FAILURE"),
        startedAt: "2026-10-22T10:00:00Z",
        completedAt: "2026-10-22T10:04:51Z",
        databaseId: 4242,
        checkSuite: { app: { slug: "github-actions" } },
      },
      {
        ...run("external", "FAILURE"),
        summary: "Deploy preview failed: build exited 1",
        checkSuite: { app: { slug: "cloudflare-pages" } },
      },
      {
        ...run("check / lint", "SUCCESS"),
        databaseId: 7,
        checkSuite: { app: { slug: "github-actions" } },
      },
      run("CodeQL", null),
    ]),
  );
  const client = f.input.client;
  const result = await waitForMergeReadiness({
    ...f.input,
    client: {
      async request(request) {
        if (request.path.includes("/actions/jobs/")) {
          logReads.push({ path: request.path, token: request.token, accept: request.accept });
          return { status: 200, body: ACTIONS_LOG };
        }
        return client.request(request);
      },
    },
  });
  expect(logReads).toEqual([
    {
      path: "/repos/owner/repo/actions/jobs/4242/logs",
      token: "synthetic-token-1",
      accept: "text",
    },
  ]);
  expect(result.outcome).toBe("ci_failed");
  const tail = [
    "bun test v1.4.2",
    "✗ lists a draining runner's sessions",
    " 1 fail",
    "##[error]Process completed with exit code 1.",
  ].join("\n");
  expect(result.failedChecks).toEqual([
    {
      name: "check / test",
      url: "https://ci.example/check / test",
      logTail: tail,
      failsOnBase: false,
    },
    {
      name: "external",
      url: "https://ci.example/external",
      logTail: "Deploy preview failed: build exited 1",
      failsOnBase: false,
    },
  ]);
  expect(result.checks?.map((check) => [check.name, check.state, check.logSource])).toEqual([
    ["check / test", "failed", "actions"],
    ["external", "failed", "summary"],
    ["check / lint", "passed", null],
    ["CodeQL", "running", null],
  ]);
  expect(result.checks?.[0]).toMatchObject({
    startedAt: "2026-10-22T10:00:00Z",
    completedAt: "2026-10-22T10:04:51Z",
  });
});

test("an unreadable Actions log falls back to the check's summary, or none", async () => {
  for (const [summary, expected] of [
    ["Tests failed", "Tests failed"],
    [null, null],
  ] as const) {
    const f = fixture(() =>
      withChecks([
        {
          ...run("test", "FAILURE"),
          databaseId: 1,
          summary,
          checkSuite: { app: { slug: "github-actions" } },
        },
      ]),
    );
    const client = f.input.client;
    const result = await waitForMergeReadiness({
      ...f.input,
      client: {
        async request(request) {
          if (request.path.includes("/actions/jobs/")) return { status: 403, body: "" };
          return client.request(request);
        },
      },
    });
    expect(result.failedChecks?.[0]?.logTail).toBe(expected);
    expect(result.checks?.[0]?.logSource).toBe(expected === null ? null : "summary");
  }
});

test("a log tail keeps the last lines up to the last error", () => {
  const long = Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\n");
  const tail = logTail(long).split("\n");
  expect(tail).toHaveLength(60);
  expect(tail.at(-1)).toBe("line 199");
  expect(logTail("\n\n  \nonly\n\n")).toBe("only");
  expect(logTail("x".repeat(10_000))).toHaveLength(6000);
});

test("a text read follows the log redirect without sending the token to the other host", async () => {
  const calls: { url: string; auth: string | null; redirect?: string }[] = [];
  const client = createFetchGitHubClient(async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      auth: new Headers(init?.headers).get("authorization"),
      ...(init?.redirect ? { redirect: init.redirect } : {}),
    });
    return url.startsWith("https://api.github.test")
      ? new Response(null, { status: 302, headers: { location: "https://logs.example/job?sig=1" } })
      : new Response("log text", { status: 200 });
  }, "https://api.github.test");
  const response = await client.request({
    method: "GET",
    path: "/repos/o/r/actions/jobs/1/logs",
    token: "synthetic",
    accept: "text",
  });
  expect(response).toEqual({ status: 200, body: "log text" });
  expect(calls).toEqual([
    {
      url: "https://api.github.test/repos/o/r/actions/jobs/1/logs",
      auth: "Bearer synthetic",
      redirect: "manual",
    },
    { url: "https://logs.example/job?sig=1", auth: null },
  ]);
});
