import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { linearBudgetStore, migrate, openDatabase } from "../src/db";
import { createLinearClient, createLinearLedger, LinearRateLimitError } from "../src/linear";

const AUTH = {
  hasToken: () => true,
  ensureFresh: async () => "token",
  forceRefresh: async () => "token",
};

const START = Date.parse("2026-11-06T09:00:00.000Z");
const RESET = START + 3_600_000;

type Seen = { remaining: number; reset: number };

function headers({ remaining, reset }: Seen): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-ratelimit-requests-remaining": String(remaining),
    "x-ratelimit-requests-limit": "100",
    "x-ratelimit-requests-reset": String(reset),
  };
}

const opened: Database[] = [];
const dirs: string[] = [];
let received = 0;

afterEach(() => {
  received = 0;
  for (const db of opened.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function acmeDatabase(): string {
  const dir = mkdtempSync(join(tmpdir(), "paws-acme-budget-"));
  dirs.push(dir);
  const path = join(dir, "paws.sqlite");
  const db = openDatabase(path);
  migrate(db);
  db.close();
  return path;
}

function instance(
  path: string,
  clock: () => number,
  limited = () => false,
  seen = (): Seen => ({ remaining: 100 - received, reset: RESET }),
  answered: () => Promise<void> = async () => {},
) {
  const db = openDatabase(path);
  opened.push(db);
  let sent = 0;
  const ledger = createLinearLedger({
    now: clock,
    random: () => 0,
    log: () => {},
    shared: linearBudgetStore(db, "acme"),
  });
  const client = createLinearClient({
    auth: AUTH,
    ledger,
    fetch: async () => {
      sent += 1;
      received += 1;
      await answered();
      const body = limited()
        ? { errors: [{ message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } }] }
        : { data: { viewer: { id: "acme-app" } } };
      return new Response(JSON.stringify(body), { status: 200, headers: headers(seen()) });
    },
  });
  return { ledger, client, sent: () => sent };
}

const ask = (client: { query(query: string): Promise<unknown> }) =>
  client.query("query { viewer { id } }").then(
    () => "sent",
    (error: unknown) => (error instanceof LinearRateLimitError ? "held" : "failed"),
  );

describe("shared Linear request budget", () => {
  test("two instances together stay within one budget in a burst", async () => {
    const path = acmeDatabase();
    const now = () => START;
    const web = instance(path, now);
    const worker = instance(path, now);
    expect(await ask(web.client)).toBe("sent");
    expect(await ask(worker.client)).toBe("sent");

    const burst = await Promise.all(
      Array.from({ length: 120 }, (_, index) => ask(index % 2 === 0 ? web.client : worker.client)),
    );

    expect(web.sent() + worker.sent()).toBe(95);
    expect(burst.filter((result) => result === "held")).toHaveLength(120 + 2 - 95);
    expect(burst).not.toContain("failed");
    expect(web.sent()).toBeGreaterThan(10);
    expect(worker.sent()).toBeGreaterThan(10);
  });

  test("a new window lets both instances spend again", async () => {
    const path = acmeDatabase();
    let clock = START;
    const web = instance(path, () => clock);
    const worker = instance(path, () => clock);
    await ask(web.client);
    await Promise.all(Array.from({ length: 120 }, () => ask(worker.client)));
    expect(await ask(web.client)).toBe("held");

    clock = START + 3_600_000;
    expect(await ask(web.client)).toBe("sent");
    expect(await ask(worker.client)).toBe("sent");
  });

  test("a hold set by one instance is honoured by the other", async () => {
    const path = acmeDatabase();
    let clock = START;
    let rateLimited = true;
    const web = instance(
      path,
      () => clock,
      () => rateLimited,
    );
    const worker = instance(path, () => clock);

    expect(await ask(web.client)).toBe("held");
    expect(web.ledger.usage().holdUntilMs).toBe(START + 15_000);

    clock += 5_000;
    const held = await worker.client.query("query { viewer { id } }").catch((error) => error);
    expect(held).toBeInstanceOf(LinearRateLimitError);
    expect((held as LinearRateLimitError).retryAfterMs).toBe(10_000);
    expect(worker.sent()).toBe(0);
    expect(worker.ledger.usage().holdUntilMs).toBe(START + 15_000);
    expect(worker.ledger.admit("intake")).toBeInstanceOf(LinearRateLimitError);

    clock = START + 15_000;
    rateLimited = false;
    expect(await ask(worker.client)).toBe("sent");
    expect(await ask(web.client)).toBe("sent");
    expect(worker.ledger.usage().holdUntilMs).toBeNull();
  });

  test("a replica that has not heard from Linear yet spends within the learned cap", async () => {
    const path = acmeDatabase();
    const now = () => START;
    const web = instance(path, now);
    expect(await ask(web.client)).toBe("sent");
    await Promise.all(Array.from({ length: 100 }, () => ask(web.client)));
    expect(web.sent()).toBe(95);

    const cold = instance(path, now);
    const burst = await Promise.all(Array.from({ length: 120 }, () => ask(cold.client)));

    expect(cold.sent()).toBe(0);
    expect(burst.every((result) => result === "held")).toBe(true);
  });

  test("the shared window ends at Linear's reset, not an hour after the first request", async () => {
    const path = acmeDatabase();
    let clock = START;
    const reset = START + 10 * 60_000;
    const web = instance(
      path,
      () => clock,
      () => false,
      () => ({
        remaining: clock < reset ? 5 : 100,
        reset: clock < reset ? reset : reset + 3_600_000,
      }),
    );
    expect(await ask(web.client)).toBe("sent");

    const held = await web.client.query("query { viewer { id } }").catch((error) => error);
    expect(held).toBeInstanceOf(LinearRateLimitError);
    expect((held as LinearRateLimitError).retryAfterMs).toBe(10 * 60_000);

    clock = reset;
    expect(await ask(web.client)).toBe("sent");
    expect(await ask(web.client)).toBe("sent");
  });

  test("a late response from a window that already ended does not reset the shared count", async () => {
    const path = acmeDatabase();
    let stale = false;
    const now = () => START;
    const web = instance(
      path,
      now,
      () => false,
      () => ({ remaining: 100 - received, reset: stale ? START : RESET }),
    );
    const worker = instance(path, now);
    expect(await ask(web.client)).toBe("sent");
    stale = true;
    await Promise.all(Array.from({ length: 120 }, () => ask(web.client)));
    expect(web.sent()).toBe(95);

    expect(await ask(worker.client)).toBe("held");
    expect(await ask(web.client)).toBe("held");
  });

  test("a reset that moves with each response follows Linear's count instead of keeping old spending", async () => {
    const path = acmeDatabase();
    let responses = 0;
    let clock = START;
    const moving = () => ({ remaining: 90, reset: clock + 3_600_000 + ++responses });
    const web = instance(
      path,
      () => clock,
      () => false,
      moving,
    );
    const worker = instance(
      path,
      () => clock,
      () => false,
      moving,
    );
    expect(await ask(web.client)).toBe("sent");
    expect(await ask(worker.client)).toBe("sent");
    await Promise.all(
      Array.from({ length: 120 }, (_, index) => ask(index % 2 === 0 ? web.client : worker.client)),
    );
    expect(web.sent() + worker.sent()).toBe(2 + 95 - 10);

    const sustained: string[] = [];
    for (let minute = 1; minute <= 200; minute += 1) {
      clock = START + minute * 60_000;
      sustained.push(await ask(minute % 2 === 0 ? web.client : worker.client));
    }
    expect(sustained.every((result) => result === "sent")).toBe(true);
  });

  test("requests still in flight count when a response moves the window or arrives late", async () => {
    const path = acmeDatabase();
    const now = () => START;
    let answer = () => {};
    const gate = new Promise<void>((resolve) => (answer = resolve));
    const web = instance(path, now, undefined, undefined, () => gate);
    const worker = instance(path, now);
    expect(await ask(worker.client)).toBe("sent");
    const inFlight = Array.from({ length: 120 }, () => ask(web.client));
    await Bun.sleep(20);
    expect(web.sent()).toBe(94);

    const response = (remaining: number, reset: number) => ({
      requestsRemaining: remaining,
      requestsLimit: 100,
      requestsResetMs: reset,
      complexityRemaining: null,
      complexityLimit: null,
      complexityResetMs: null,
      complexity: null,
    });
    worker.ledger.observe("tracker", response(89, RESET + 5));
    expect(await ask(worker.client)).toBe("held");
    worker.ledger.observe("tracker", response(99, RESET - 5));
    expect(await ask(worker.client)).toBe("held");

    answer();
    await Promise.all(inFlight);
    expect(worker.sent() + web.sent()).toBe(95);
    expect(await ask(worker.client)).toBe("held");
  });
});
