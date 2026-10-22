import { expect, test } from "bun:test";
import { fakeMergeReadiness, fakeRequiredChecks, type FakeCheckContext } from "./fake";
import { waitForMergeReadiness } from "./readiness";
import type { GitHubResponse } from "./types";

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
  // The verdict only; the head's check list has its own tests below.
  const {
    checks: _checks,
    ciOutcome: _ciOutcome,
    ...verdict
  } = await waitForMergeReadiness({
    ...f.input,
    releaseWhilePending: true,
  });
  return verdict;
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
  expect(result.failedChecks).toEqual([{ name: "check-100", url: "https://ci.example/check-100" }]);
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
    expect(result).toEqual({
      outcome: "ci_failed",
      message: "CI failed on the candidate commit",
      failedChecks: [{ name: "build", url: "https://ci.example/build" }],
    });
  }
  const status = await readOnce(() =>
    withChecks([{ context: "legacy", state: "ERROR", targetUrl: "https://ci.example/legacy" }]),
  );
  expect(status.failedChecks).toEqual([{ name: "legacy", url: "https://ci.example/legacy" }]);
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
  const original = console.error;
  console.error = (message: string) => logged.push(message);
  try {
    await waitForMergeReadiness(f.input);
  } finally {
    console.error = original;
  }
  expect(logged[0]).toContain("The Linear publication was superseded.");
  expect(logged.join("\n")).not.toContain(token);
});

test("a CI failure lists every head check and reads the failed ones' log tails", async () => {
  const requests: string[] = [];
  const log = [
    ...Array.from({ length: 80 }, (_, line) => `2026-10-21T10:00:00.0000000Z setup ${line}`),
    "2026-10-21T10:00:01.0000000Z (fail) lists a draining runner's sessions",
    "2026-10-21T10:00:01.0000000Z token ghs_abcdefghijklmnopqrstuvwxyz0123456789",
  ].join("\n");
  const f = fixture(() =>
    withChecks([
      {
        name: "check / lint",
        conclusion: "SUCCESS",
        detailsUrl: "https://ci.example/lint",
        startedAt: "2026-10-21T10:00:00Z",
        completedAt: "2026-10-21T10:00:38Z",
      },
      {
        name: "check / test",
        conclusion: "FAILURE",
        detailsUrl: "https://ci.example/test",
        databaseId: 7,
        checkSuite: { app: { slug: "github-actions" } },
        startedAt: "2026-10-21T10:00:00Z",
        completedAt: "2026-10-21T10:04:51Z",
        summary: "not used: the job log wins",
      },
      {
        name: "Cloudflare Pages",
        conclusion: "FAILURE",
        detailsUrl: "https://pages.example/1",
        checkSuite: { app: { slug: "cloudflare-pages" } },
        summary: "Build failed",
        text: "exit 1",
      },
      { name: "CodeQL", conclusion: null, detailsUrl: null, startedAt: "2026-10-21T10:00:00Z" },
      { context: "legacy", state: "ERROR", targetUrl: null, description: "deploy failed" },
    ]),
  );
  const result = await waitForMergeReadiness({
    ...f.input,
    client: {
      async request(request) {
        requests.push(request.path);
        if (request.path === "/repos/owner/repo/actions/jobs/7/logs")
          return { status: 200, body: { message: "non-json response" }, text: log };
        return f.input.client.request(request);
      },
    },
  });
  expect(result.outcome).toBe("ci_failed");
  expect(requests.filter((path) => path.includes("/actions/"))).toEqual([
    "/repos/owner/repo/actions/jobs/7/logs",
  ]);
  const checks = result.checks ?? [];
  expect(checks.map((check) => [check.name, check.state, check.logSource])).toEqual([
    ["check / lint", "passed", null],
    ["check / test", "failed", "actions"],
    ["Cloudflare Pages", "failed", "summary"],
    ["CodeQL", "running", null],
    ["legacy", "failed", "summary"],
  ]);
  expect(checks[0]).toMatchObject({
    url: "https://ci.example/lint",
    startedAt: "2026-10-21T10:00:00Z",
    completedAt: "2026-10-21T10:00:38Z",
    logTail: null,
  });
  const tail = checks[1]?.logTail ?? "";
  expect(tail.split("\n")).toHaveLength(60);
  expect(tail).not.toContain("2026-10-21T");
  expect(tail).toContain("(fail) lists a draining runner's sessions");
  expect(tail).not.toContain("ghs_abcdefghij");
  expect(checks[2]?.logTail).toBe("Build failed\n\nexit 1");
  expect(checks[4]?.logTail).toBe("deploy failed");
  expect(result.failedChecks?.[0]).toEqual({
    name: "check / test",
    url: "https://ci.example/test",
    logTail: tail,
  });
});

test("an unreadable job log falls back to the summary and still fails CI", async () => {
  const f = fixture(() =>
    withChecks([
      {
        name: "test",
        conclusion: "FAILURE",
        detailsUrl: null,
        databaseId: 9,
        checkSuite: { app: { slug: "github-actions" } },
        summary: "1 failing test",
      },
      {
        name: "build",
        conclusion: "FAILURE",
        detailsUrl: null,
        databaseId: 10,
        checkSuite: { app: { slug: "github-actions" } },
      },
    ]),
  );
  const result = await waitForMergeReadiness({
    ...f.input,
    client: {
      async request(request) {
        if (request.path.endsWith("/jobs/9/logs")) return { status: 410, body: {} };
        if (request.path.endsWith("/jobs/10/logs")) throw new Error("network down");
        return f.input.client.request(request);
      },
    },
  });
  expect(result.outcome).toBe("ci_failed");
  expect(result.checks?.map((check) => [check.logTail, check.logSource])).toEqual([
    ["1 failing test", "summary"],
    [null, null],
  ]);
});

test("pending and green reads carry the head's checks without reading logs", async () => {
  const pending = await waitForMergeReadiness({
    ...fixture(() => withChecks([run("build", "SUCCESS"), run("e2e", null)])).input,
    releaseWhilePending: true,
  });
  expect(pending.outcome).toBe("pending");
  expect(pending.checks?.map((check) => check.state)).toEqual(["passed", "running"]);
  const ready = await waitForMergeReadiness(
    fixture(() => withChecks([run("build", "SUCCESS")])).input,
  );
  expect(ready.outcome).toBe("ready");
  expect(ready.checks).toEqual([
    {
      name: "build",
      state: "passed",
      url: "https://ci.example/build",
      startedAt: null,
      completedAt: null,
      logTail: null,
      logSource: null,
    },
  ]);
});

test("failed checks with the same name each keep their own log tail", async () => {
  const failing = (url: string, summary: string): FakeCheckContext => ({
    name: "test",
    conclusion: "FAILURE",
    detailsUrl: url,
    summary,
  });
  const result = await waitForMergeReadiness(
    fixture(() =>
      withChecks([
        failing("https://ci.example/a", "first failure"),
        failing("https://ci.example/b", "second failure"),
      ]),
    ).input,
  );
  expect(result.failedChecks).toEqual([
    { name: "test", url: "https://ci.example/a", logTail: "first failure" },
    { name: "test", url: "https://ci.example/b", logTail: "second failure" },
  ]);
});

test("CI stays running while a required check has not reported, even if the rest passed", async () => {
  const waiting = await waitForMergeReadiness({
    ...fixture(() => withChecks([run("build", "SUCCESS")]), { protection: ["deploy preview"] })
      .input,
    releaseWhilePending: true,
  });
  expect(waiting.outcome).toBe("pending");
  expect(waiting.ciOutcome).toBe("running");
  const failed = await waitForMergeReadiness(
    fixture(() => withChecks([run("build", "FAILURE")])).input,
  );
  expect(failed.ciOutcome).toBe("failed");
  const green = await waitForMergeReadiness(
    fixture(() => withChecks([run("build", "SUCCESS")])).input,
  );
  expect(green.ciOutcome).toBe("passed");
});

test("CI is passed while the merge still waits on review threads", async () => {
  const result = await waitForMergeReadiness({
    ...fixture(() => {
      const reply = withChecks([run("build", "SUCCESS")]);
      reply.body.data.repository.pullRequest.reviewThreads.nodes = [{ isResolved: false }];
      return reply;
    }).input,
    releaseWhilePending: true,
  });
  expect(result.outcome).toBe("pending");
  expect(result.ciOutcome).toBe("passed");
});
