import { expect, test } from "bun:test";
import { fakeMergeReadiness } from "./fake";
import { waitForMergeReadiness } from "./readiness";
import type { GitHubResponse } from "./types";

const head = "a".repeat(40);

function fixture(reply: (cursor: string | null, poll: number) => GitHubResponse) {
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
      async request(request: { path: string; token: string; body?: unknown }) {
        expect(request.path).toBe("/graphql");
        const variables = (request.body as { variables: Record<string, unknown> }).variables;
        expect(variables.head).toBe(head);
        expect(variables.number).toBe(12);
        tokens.push(request.token);
        return reply(variables.cursor as string | null, polls);
      },
    },
  };
  return { input, tokens, sleeps: () => sleeps };
}

test("waits for both check runs and legacy statuses on the exact candidate", async () => {
  const f = fixture((_, poll) => {
    const body = fakeMergeReadiness(head);
    const checks = body.data.repository.object.statusCheckRollup;
    checks.contexts.statusContextCount = 1;
    checks.state = poll === 1 ? "PENDING" : "SUCCESS";
    return { status: 200, body };
  });
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
  expect(messages).toEqual(["Waiting for CI on the candidate commit."]);
});

test("reads every review thread page and waits until unresolved threads are resolved", async () => {
  const cursors: (string | null)[] = [];
  const f = fixture((cursor, poll) => {
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
      body.data.repository.object.statusCheckRollup.contexts.checkRunCount = 0;
      return { status: 200, body };
    });
    const result = await waitForMergeReadiness(f.input);
    expect(result.outcome).toBe("blocked");
    expect(result.message).toContain("timed out");
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
    expect(f.sleeps()).toBe(0);
  });
}
