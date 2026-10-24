import { describe, expect, test } from "bun:test";
import {
  createLinearClient,
  createLinearIssueLifecycle,
  createLinearLedger,
  createLinearTracker,
  linearCaller,
  linearItem,
  LinearRateLimitError,
} from "../src/linear";
import { createPersonalLinearClient } from "../src/comments";
import { isTransientFailure, transientRetryDelayMs } from "../src/core";
import { migrate, openDatabase } from "../src/db";
import { startServer } from "../src/server";

const AUTH = {
  hasToken: () => true,
  ensureFresh: async () => "token",
  forceRefresh: async () => "token",
};

const START = Date.parse("2026-10-22T18:00:00.000Z");

function linearResponse(headers: Record<string, string>, limited = false): Response {
  const body = limited
    ? { errors: [{ message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } }] }
    : { data: { viewer: { id: "app" } } };
  return new Response(JSON.stringify(body), {
    status: limited ? 400 : 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

function budgetHeaders(requestsRemaining: number, complexity: number, resetMs: number) {
  return {
    "x-complexity": String(complexity),
    "x-ratelimit-requests-remaining": String(requestsRemaining),
    "x-ratelimit-requests-limit": "5000",
    "x-ratelimit-requests-reset": String(resetMs),
    "x-ratelimit-complexity-remaining": "1900000",
    "x-ratelimit-complexity-limit": "2000000",
    "x-ratelimit-complexity-reset": String(resetMs),
  };
}

describe("shared Linear budget", () => {
  test("counts requests and complexity per caller over a rolling hour", async () => {
    let now = START;
    const ledger = createLinearLedger({ now: () => now, log: () => {} });
    const client = createLinearClient({
      auth: AUTH,
      fetch: async () => linearResponse(budgetHeaders(4000, 300, START + 3_600_000)),
      ledger,
    });
    await linearCaller("poller", () => client.query("query { viewer { id } }"));
    await linearCaller("poller", () => client.query("query { viewer { id } }"));
    await linearCaller("outbox", () => client.query("query { viewer { id } }"));
    await client.query("query { viewer { id } }");
    expect(ledger.usage().callers).toEqual({
      poller: { requests: 2, complexity: 600, rateLimited: 0, held: 0 },
      outbox: { requests: 1, complexity: 300, rateLimited: 0, held: 0 },
      tracker: { requests: 1, complexity: 300, rateLimited: 0, held: 0 },
    });
    expect(ledger.usage().budget).toMatchObject({
      requestsRemaining: 4000,
      requestsLimit: 5000,
      complexityRemaining: 1900000,
      complexityLimit: 2000000,
    });
    now += 30 * 60_000;
    await linearCaller("outbox", () => client.query("query { viewer { id } }"));
    now += 31 * 60_000;
    expect(ledger.usage().callers).toEqual({
      outbox: { requests: 1, complexity: 300, rateLimited: 0, held: 0 },
    });
  });

  test("a RATELIMITED response holds every client on the ledger until the reset", async () => {
    let now = START;
    const lines: string[] = [];
    const ledger = createLinearLedger({
      now: () => now,
      random: () => 0.5,
      log: (line) => lines.push(line),
    });
    const reset = START + 120_000;
    let limitedCalls = 0;
    const limited = createLinearClient({
      auth: AUTH,
      fetch: async () => {
        limitedCalls += 1;
        return linearResponse(budgetHeaders(0, 10, reset), true);
      },
      ledger,
    });
    let otherCalls = 0;
    const other = createLinearClient({
      auth: AUTH,
      fetch: async () => {
        otherCalls += 1;
        return linearResponse(budgetHeaders(4999, 10, reset));
      },
      ledger,
    });

    const first = await linearCaller("poller", () =>
      limited.query("query { viewer { id } }"),
    ).catch((error: unknown) => error);
    expect(first).toBeInstanceOf(LinearRateLimitError);
    expect((first as LinearRateLimitError).retryAfterMs).toBeGreaterThanOrEqual(120_000);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("caller=poller");
    expect(lines[0]).toContain("requests 0/5000");

    now += 60_000;
    const held = await linearCaller("outbox", () => other.query("query { viewer { id } }")).catch(
      (error: unknown) => error,
    );
    expect(held).toBeInstanceOf(LinearRateLimitError);
    expect((held as LinearRateLimitError).retryAfterMs).toBeGreaterThanOrEqual(60_000);
    expect((held as LinearRateLimitError).retryAfterMs).toBeLessThan(120_000);
    expect(otherCalls).toBe(0);
    expect(limitedCalls).toBe(1);
    expect(ledger.usage().holdUntilMs).toBeGreaterThanOrEqual(reset);
    expect(ledger.usage().callers).toMatchObject({
      poller: { requests: 1, rateLimited: 1, held: 0 },
      outbox: { requests: 0, rateLimited: 0, held: 1 },
    });

    now = reset + 10_000;
    await linearCaller("outbox", () => other.query("query { viewer { id } }"));
    expect(otherCalls).toBe(1);
    expect(ledger.usage().holdUntilMs).toBeNull();
  });

  test("a RATELIMITED response retries at the reset of the limit that ran out", async () => {
    const ledger = createLinearLedger({ now: () => START, random: () => 0, log: () => {} });
    const client = createLinearClient({
      auth: AUTH,
      fetch: async () =>
        linearResponse(
          {
            ...budgetHeaders(4000, 10, START + 3_600_000),
            "x-ratelimit-complexity-remaining": "0",
            "x-ratelimit-complexity-reset": String(START + 90_000),
          },
          true,
        ),
      ledger,
    });
    const error = await client.query("query { viewer { id } }").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LinearRateLimitError);
    expect((error as LinearRateLimitError).retryAfterMs).toBe(90_000);
    expect(transientRetryDelayMs(0, error)).toBe(90_000);
  });

  test("a personal-key RATELIMITED response retries at its requests reset", async () => {
    const reset = Date.now() + 90_000;
    const client = createPersonalLinearClient({
      apiKey: "key",
      fetch: async () => linearResponse(budgetHeaders(0, 10, reset), true),
    });
    const error = await client.query("query { viewer { id } }").catch((caught: unknown) => caught);
    expect(isTransientFailure(error)).toBe(true);
    expect(transientRetryDelayMs(0, error)).toBeGreaterThan(85_000);
    expect(transientRetryDelayMs(0, error)).toBeLessThanOrEqual(90_000);
  });

  test("an exhausted endpoint limit holds that endpoint only", async () => {
    let now = START;
    const ledger = createLinearLedger({ now: () => now, random: () => 0, log: () => {} });
    const reset = START + 60_000;
    const sent: string[] = [];
    const client = createLinearClient({
      auth: AUTH,
      fetch: async (_url, init) => {
        const query = String(JSON.parse(String(init?.body)).query);
        sent.push(query);
        if (!query.includes("issueCreate")) return linearResponse(budgetHeaders(4000, 10, reset));
        return linearResponse(
          {
            ...budgetHeaders(4000, 10, reset),
            "x-ratelimit-endpoint-name": "issueCreate",
            "x-ratelimit-endpoint-requests-limit": "100",
            "x-ratelimit-endpoint-requests-remaining": "0",
            "x-ratelimit-endpoint-requests-reset": String(reset),
          },
          true,
        );
      },
      ledger,
    });
    const create = "mutation { issueCreate }";
    const first = await client.query(create).catch((caught: unknown) => caught);
    expect((first as LinearRateLimitError).retryAfterMs).toBe(60_000);
    expect(ledger.usage().holdUntilMs).toBeNull();

    now += 20_000;
    const held = await linearCaller("outbox", () => client.query(create)).catch(
      (caught: unknown) => caught,
    );
    expect((held as LinearRateLimitError).retryAfterMs).toBe(40_000);
    await linearCaller("outbox", () => client.query("query { viewer { id } }"));
    expect(sent).toEqual([create, "query { viewer { id } }"]);
    expect(ledger.usage().endpoints).toEqual([
      { name: "issueCreate", requestsRemaining: 0, requestsLimit: 100, requestsResetMs: reset },
    ]);

    now = reset + 1;
    await client.query(create).catch(() => {});
    expect(sent).toHaveLength(3);
  });

  test("a low budget holds background calls, then normal calls, while critical calls go", async () => {
    const now = START;
    const ledger = createLinearLedger({ now: () => now, random: () => 0, log: () => {} });
    const reset = START + 600_000;
    let remaining = 900;
    const sent: string[] = [];
    const client = createLinearClient({
      auth: AUTH,
      fetch: async (_url, init) => {
        sent.push(String(JSON.parse(String(init?.body)).query));
        return linearResponse(budgetHeaders(remaining, 10, reset));
      },
      ledger,
    });
    const ask = (caller: string, priority?: "critical" | "normal" | "background") =>
      linearCaller(caller, () => client.query(`query { ${caller} }`), priority).then(
        () => "sent",
        (error: unknown) =>
          error instanceof LinearRateLimitError ? `held ${error.retryAfterMs}` : "failed",
      );

    expect(await ask("tracker")).toBe("sent");
    expect(await ask("poller")).toBe("held 600000");
    expect(await ask("repository-hints", "background")).toBe("held 600000");
    expect(await ask("outbox")).toBe("sent");
    remaining = 200;
    expect(await ask("outbox")).toBe("sent");
    expect(await ask("outbox")).toBe("held 600000");
    expect(await ask("events", "critical")).toBe("sent");
    expect(await ask("outbox", "critical")).toBe("sent");
    expect(sent).toEqual([
      "query { tracker }",
      "query { outbox }",
      "query { outbox }",
      "query { events }",
      "query { outbox }",
    ]);
    expect(ledger.usage().callers["poller"]).toMatchObject({ requests: 0, held: 1 });
  });

  test("a low budget is forgotten once its reset passes", async () => {
    let now = START;
    const ledger = createLinearLedger({ now: () => now, random: () => 0, log: () => {} });
    let calls = 0;
    const client = createLinearClient({
      auth: AUTH,
      fetch: async () => {
        calls += 1;
        return linearResponse(budgetHeaders(10, 10, START + 60_000));
      },
      ledger,
    });
    await client.query("query { viewer { id } }");
    await expect(
      linearCaller("poller", () => client.query("query { viewer { id } }")),
    ).rejects.toBeInstanceOf(LinearRateLimitError);
    now = START + 60_001;
    await linearCaller("poller", () => client.query("query { viewer { id } }"));
    expect(calls).toBe(2);
  });

  test("tracker reads count under their own caller unless a caller already holds them", async () => {
    const ledger = createLinearLedger({ log: () => {} });
    const client = createLinearClient({
      auth: AUTH,
      fetch: async () => linearResponse(budgetHeaders(4000, 10, START + 3_600_000)),
      ledger,
    });
    const tracker = createLinearTracker(client);
    const lifecycle = createLinearIssueLifecycle(client);
    const ignore = () => {};
    await tracker.loadEpic("issue").catch(ignore);
    await tracker.getIssueContext!("issue").catch(ignore);
    await tracker.listProjectMembers!("project").catch(ignore);
    await lifecycle.inspect("issue").catch(ignore);
    await linearCaller("intake", () => tracker.loadEpic("issue").catch(ignore));
    expect(Object.keys(ledger.usage().callers).sort()).toEqual([
      "intake",
      "issue-context",
      "issue-inspect",
      "issue-snapshot",
      "project-members",
    ]);
  });

  test("counts requests per work item over the rolling hour", async () => {
    let now = START;
    const ledger = createLinearLedger({ now: () => now, log: () => {} });
    const client = createLinearClient({
      auth: AUTH,
      fetch: async () => linearResponse(budgetHeaders(4000, 10, START + 3_600_000)),
      ledger,
    });
    const viewer = () => client.query("query { viewer { id } }");
    await linearItem("PAS-1", () => linearCaller("outbox", viewer));
    await linearCaller("context", () => linearItem("PAS-2", viewer));
    now += 31 * 60_000;
    await linearItem("PAS-2", viewer);
    await linearItem("PAS-2", () => linearCaller("outbox", viewer));
    await viewer();
    expect(ledger.usage().items).toEqual([
      { item: "PAS-2", requests: 3 },
      { item: "PAS-1", requests: 1 },
    ]);
    expect(ledger.usage().callers["context"]?.requests).toBe(1);
    now += 30 * 60_000;
    expect(ledger.usage().items).toEqual([{ item: "PAS-2", requests: 2 }]);
  });

  test("counts each request toward its task for the run page", async () => {
    const counted: string[][] = [];
    const ledger = createLinearLedger({
      log: () => {},
      countItem: (id, caller) => counted.push([id, caller]),
    });
    const client = createLinearClient({
      auth: AUTH,
      fetch: async () => linearResponse(budgetHeaders(4000, 10, START + 3_600_000)),
      ledger,
    });
    const viewer = () => client.query("query { viewer { id } }");
    await linearItem("PAS-1", () => linearCaller("outbox", viewer), "item-1");
    await linearCaller("context", () => linearItem("PAS-1", viewer, "item-1"));
    await linearItem("PAS-2", viewer);
    await viewer();
    expect(counted).toEqual([
      ["item-1", "outbox"],
      ["item-1", "context"],
    ]);
    expect(ledger.usage().items).toEqual([
      { item: "PAS-1", requests: 2 },
      { item: "PAS-2", requests: 1 },
    ]);
  });

  test("/health reports the Linear usage", async () => {
    const ledger = createLinearLedger({ log: () => {} });
    const server = startServer({
      port: 0,
      hostname: "127.0.0.1",
      webhooks: false,
      linearUsage: () => ledger.usage(),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/health`);
      expect(await response.json()).toMatchObject({
        ok: true,
        service: "paws",
        linear: {
          budget: null,
          holdUntilMs: null,
          windowMs: 3_600_000,
          callers: {},
          items: [],
          endpoints: [],
        },
      });
    } finally {
      await server.stop(true);
    }
  });
  test("/api/status carries the Linear budget and hold from the same ledger", async () => {
    const ledger = createLinearLedger({ now: () => START, log: () => {} });
    ledger.observe("tracker", {
      requestsRemaining: 0,
      requestsLimit: 1500,
      requestsResetMs: START + 15 * 60_000,
      complexityRemaining: null,
      complexityLimit: null,
      complexityResetMs: null,
      complexity: null,
    });
    ledger.limited("tracker", new LinearRateLimitError(15 * 60_000, ledger.usage().budget!));
    const db = openDatabase(":memory:");
    migrate(db);
    const server = startServer({
      port: 0,
      hostname: "127.0.0.1",
      webhooks: false,
      db,
      statusEnv: {},
      linearUsage: () => ledger.usage(),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/status`);
      expect(await response.json()).toMatchObject({
        source: "live",
        intake: [],
        linearBudget: {
          requestsRemaining: 0,
          requestsLimit: 1500,
          resetAt: "2026-10-22T18:15:00.000Z",
          holdUntil: "2026-10-22T18:15:00.000Z",
        },
      });
    } finally {
      await server.stop(true);
      db.close();
    }
  });
});
