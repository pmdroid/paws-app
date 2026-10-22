import { describe, expect, test } from "bun:test";
import {
  createLinearClient,
  createLinearLedger,
  linearCaller,
  LinearRateLimitError,
} from "../src/linear";
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
        linear: { budget: null, holdUntilMs: null, windowMs: 3_600_000, callers: {} },
      });
    } finally {
      await server.stop(true);
    }
  });
});
