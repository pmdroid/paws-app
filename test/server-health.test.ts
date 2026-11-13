import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { JOB_KIND } from "../src/core";
import {
  enqueueJob,
  JOB_PROGRESS_STALE_MS,
  setJournalSink,
  type Db,
  type JobLoopLiveness,
  type Q,
} from "../src/db";
import type { LinearUsage } from "../src/linear";
import { RUNNER_ONLINE_MS } from "../src/runner-placement";
import { RUNNER_LEASE_GRACE_MS } from "../src/runner-protocol";
import { startServer, type HealthReport } from "../src/server";
import { startDashboardFixture } from "./dashboard-fixture";
import { seed, withoutForeignKeys } from "./dialects";
import { tempStore } from "./pglite";

const NOW = 10 * 60 * 60_000;
const HOUR = 60 * 60_000;
const RUNNER_MAX_AGE = RUNNER_ONLINE_MS + RUNNER_LEASE_GRACE_MS;
const USAGE: LinearUsage = {
  budget: {
    requestsRemaining: 1200,
    requestsLimit: 1500,
    requestsResetMs: NOW + HOUR,
    complexityRemaining: null,
    complexityLimit: null,
    complexityResetMs: null,
    complexity: null,
  },
  holdUntilMs: null,
  windowMs: HOUR,
  callers: { "private-caller": { requests: 7, complexity: 3, rateLimited: 0, held: 0 } },
  items: [{ item: "PRIVATE-42", requests: 7 }],
  endpoints: [
    { name: "privateEndpoint", requestsRemaining: 1, requestsLimit: 2, requestsResetMs: NOW },
  ],
};
const PRIVATE = ["PRIVATE-42", "private-caller", "privateEndpoint"];

const stores: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

/** A migrated, empty store, closed after the test. */
async function emptyStore(): Promise<Db> {
  const store = await tempStore();
  stores.push(store);
  return store.db;
}

let keys = 0;
const job = (status: string, lockedUntil: number | null) => (q: Q) =>
  q.orm.insert(q.t.job).values({ queue: "health", status, lockedUntil, runAt: 0, createdAt: 0 });
const outbox = (status: string) => (q: Q) =>
  q.orm.insert(q.t.outbox).values({
    target: "linear",
    op: "health",
    idempotencyKey: `health-${++keys}`,
    payload: {},
    status,
    createdAt: 0,
  });
const runner = (status: string, lastSeenAt: number | null, revokedAt: number | null = null) =>
  function insert(q: Q) {
    const id = `runner-${++keys}`;
    return q.orm.insert(q.t.runner).values({
      id,
      workspaceId: "workspace",
      ownerUserId: "owner",
      name: id,
      status,
      lastSeenAt,
      revokedAt,
      createdAt: 0,
    });
  };

/** A migrated store with healthy rows in every table the health checks read. */
async function healthyStore(): Promise<Db> {
  const db = await emptyStore();
  // Runners are seeded without their workspace and member parents.
  await withoutForeignKeys(db);
  await seed(
    db,
    job("running", NOW + 1),
    job("done", 0),
    job("cancelled", 0),
    outbox("pending"),
    outbox("sent"),
    outbox("dropped"),
    runner("active", NOW),
    runner("paused", 0),
    runner("revoked", 0, 1),
    (q) => q.orm.insert(q.t.syncCursor).values({ name: "linear:webhook", cursorMs: NOW }),
    (q) =>
      q.orm
        .insert(q.t.githubDelivery)
        .values({ deliveryId: "delivery", event: "push", payload: "{}", receivedAt: NOW }),
  );
  return db;
}

async function probe(
  db: Db,
  options: { webhooks?: boolean; now?: number; disk?: Record<string, number> } = {},
) {
  const server = startServer({
    store: db,
    port: 0,
    hostname: "127.0.0.1",
    webhooks: options.webhooks ?? true,
    linearWebhookSecret: "test-linear",
    githubWebhookSecret: "test-github",
    healthNow: () => options.now ?? NOW,
    ...(options.disk ? { healthDisk: fakeDisk(options.disk) } : {}),
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/health`);
    return {
      status: response.status,
      body: (await response.json()) as HealthReport,
      headers: response.headers,
    };
  } finally {
    await server.stop(true);
  }
}

const GB = 1024 ** 3;

function fakeDisk(free: Record<string, number>) {
  return {
    paths: { tmpdir: "/tmp", pawsHome: "/home/paws/.paws" },
    statfs: (path: string) => ({ bavail: free[path]!, blocks: 100 * GB, bsize: 1 }),
  };
}

describe("server health", () => {
  test.each([
    [200, null],
    [503, "deadJobs"],
  ])(
    "anonymous health answers %i without Linear usage while workspace access starts",
    async (status, failed) => {
      const db = await healthyStore();
      if (failed) await seed(db, job("dead", NOW));
      let calls = 0;
      const server = startServer({
        store: db,
        port: 0,
        hostname: "127.0.0.1",
        webhooks: false,
        healthNow: () => NOW,
        linearUsage: async () => (calls++, USAGE),
        workspaceAccess: new Promise(() => {}),
      });
      const base = `http://127.0.0.1:${server.port}`;
      try {
        const response = await fetch(`${base}/health`);
        const text = await response.text();
        const body = JSON.parse(text) as HealthReport;
        expect(response.status).toBe(status);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(Object.keys(body)).toEqual([
          "ok",
          "service",
          "instance",
          "instances",
          "checks",
          "failedChecks",
        ]);
        expect(body).toMatchObject({ instance: null, instances: [] });
        expect(body).toMatchObject({ ok: !failed, service: "paws" });
        expect(body.failedChecks).toEqual(failed ? [failed] : []);
        expect(Object.keys(body.checks)).toHaveLength(9);
        for (const value of PRIVATE) expect(text).not.toContain(value);
        expect(calls).toBe(0);
        expect((await fetch(`${base}/api/issues`)).status).toBe(503);
      } finally {
        await server.stop(true);
      }
    },
  );

  test("the signed-in overview keeps the aggregate Linear budget that health leaves out", async () => {
    let calls = 0;
    const fixture = await startDashboardFixture({ linearUsage: async () => (calls++, USAGE) });
    try {
      const health = await fetch(`${fixture.origin}/health`);
      expect(await health.json()).not.toHaveProperty("linear");
      expect((await fetch(`${fixture.origin}/api/overview`)).status).toBe(401);
      expect((await fetch(`${fixture.origin}/api/issues`)).status).toBe(401);
      expect(calls).toBe(0);
      const overview = await fetch(`${fixture.origin}/api/overview`, {
        headers: { cookie: fixture.cookie },
      });
      const text = await overview.text();
      expect(JSON.parse(text).linearBudget).toEqual({
        requestsRemaining: 1200,
        requestsLimit: 1500,
        resetAt: new Date(NOW + HOUR).toISOString(),
        holdUntil: null,
      });
      for (const value of PRIVATE) expect(text).not.toContain(value);
      expect(calls).toBeGreaterThan(0);
    } finally {
      await fixture.close();
    }
  });

  test("reports every check, without caching a healthy result", async () => {
    const db = await healthyStore();
    const { status, body, headers } = await probe(db);
    expect(status).toBe(200);
    expect(headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({ ok: true, service: "paws", failedChecks: [] });
    expect(Object.keys(body.checks)).toEqual([
      "database",
      "jobLeases",
      "jobProgress",
      "deadJobs",
      "deadOutbox",
      "runnerHeartbeats",
      "linearWebhook",
      "githubWebhook",
      "diskSpace",
    ]);
    expect(body.checks.jobProgress).toEqual({ status: "skipped", reason: "not_observed" });
    expect(body.checks.diskSpace).toEqual({ status: "skipped", reason: "not_configured" });
    for (const [name, check] of Object.entries(body.checks)) {
      if (name === "jobProgress" || name === "diskSpace") continue;
      expect(check).toMatchObject({ status: "ok" });
    }
  });

  test.each<[string, string, (q: Q) => PromiseLike<unknown>]>([
    [
      "jobLeases",
      "lease expired",
      (q) => q.orm.update(q.t.job).set({ lockedUntil: NOW }).where(eq(q.t.job.status, "running")),
    ],
    [
      "jobLeases",
      "no lease",
      (q) => q.orm.update(q.t.job).set({ lockedUntil: null }).where(eq(q.t.job.status, "running")),
    ],
    ["deadJobs", "dead job", job("dead", NOW)],
    ["deadOutbox", "dead outbox row", outbox("dead")],
    [
      "runnerHeartbeats",
      "stale heartbeat",
      (q) =>
        q.orm
          .update(q.t.runner)
          .set({ lastSeenAt: NOW - RUNNER_MAX_AGE })
          .where(eq(q.t.runner.status, "active")),
    ],
    [
      "runnerHeartbeats",
      "no heartbeat",
      (q) =>
        q.orm.update(q.t.runner).set({ lastSeenAt: null }).where(eq(q.t.runner.status, "active")),
    ],
    [
      "linearWebhook",
      "old delivery",
      (q) => q.orm.update(q.t.syncCursor).set({ cursorMs: NOW - HOUR - 1 }),
    ],
    [
      "githubWebhook",
      "old delivery",
      (q) => q.orm.update(q.t.githubDelivery).set({ receivedAt: NOW - HOUR - 1 }),
    ],
    [
      "linearWebhook",
      "never received",
      (q) => q.orm.delete(q.t.syncCursor).where(eq(q.t.syncCursor.name, "linear:webhook")),
    ],
    ["githubWebhook", "never received", (q) => q.orm.delete(q.t.githubDelivery)],
  ])("returns 503 for %s (%s)", async (name, _label, change) => {
    const db = await healthyStore();
    await seed(db, change);
    const { status, body } = await probe(db);
    expect(status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.failedChecks).toEqual([name]);
    expect(body.checks[name]!.status).toBe("failed");
  });

  test.each(["/tmp", "/home/paws/.paws"])(
    "diskSpace fails below 5 GB free on a 100 GB disk at %s and passes above it",
    async (low) => {
      const db = await healthyStore();
      const free = { "/tmp": 6 * GB, "/home/paws/.paws": 6 * GB };
      const healthy = await probe(db, { disk: free });
      expect(healthy.status).toBe(200);
      expect(healthy.body.checks.diskSpace).toEqual({
        status: "ok",
        paths: {
          tmpdir: { freeBytes: 6 * GB, minFreeBytes: 5 * GB },
          pawsHome: { freeBytes: 6 * GB, minFreeBytes: 5 * GB },
        },
      });
      const full = await probe(db, { disk: { ...free, [low]: 5 * GB - 1 } });
      expect(full.status).toBe(503);
      expect(full.body.failedChecks).toEqual(["diskSpace"]);
      expect(JSON.stringify(full.body)).not.toContain(low);
    },
  );

  test("diskSpace keeps a 1 GB floor on a small disk", async () => {
    const db = await healthyStore();
    const small = (free: number) => ({
      paths: { tmpdir: "/tmp" },
      statfs: () => ({ bavail: free, blocks: 4 * GB, bsize: 1 }),
    });
    const probeSmall = async (free: number) => {
      const server = startServer({
        store: db,
        port: 0,
        hostname: "127.0.0.1",
        webhooks: false,
        healthNow: () => NOW,
        healthDisk: small(free),
      });
      try {
        const response = await fetch(`http://127.0.0.1:${server.port}/health`);
        return ((await response.json()) as HealthReport).checks.diskSpace;
      } finally {
        await server.stop(true);
      }
    };
    expect(await probeSmall(GB - 1)).toMatchObject({ status: "failed" });
    expect(await probeSmall(GB)).toEqual({
      status: "ok",
      paths: { tmpdir: { freeBytes: GB, minFreeBytes: GB } },
    });
  });

  test("database read failure returns 503 without exposing the error", async () => {
    const store = await tempStore();
    await store.close();
    const { status, body } = await probe(store.db);
    expect(status).toBe(503);
    expect(body.failedChecks).toEqual(["database"]);
    expect(body.checks.database).toEqual({ status: "failed", reason: "unavailable" });
    expect(body.checks.jobLeases).toEqual({ status: "skipped", reason: "database_unavailable" });
  });

  test("checks use the webhook and heartbeat freshness boundaries", async () => {
    const db = await healthyStore();
    await seed(
      db,
      (q) =>
        q.orm
          .update(q.t.runner)
          .set({ lastSeenAt: NOW - RUNNER_MAX_AGE + 1 })
          .where(eq(q.t.runner.status, "active")),
      (q) => q.orm.update(q.t.syncCursor).set({ cursorMs: NOW - HOUR }),
      (q) => q.orm.update(q.t.githubDelivery).set({ receivedAt: NOW - HOUR }),
    );
    const { status, body } = await probe(db);
    expect(status).toBe(200);
    expect(body.checks.runnerHeartbeats).toMatchObject({
      ageMs: RUNNER_MAX_AGE - 1,
      maxAgeMs: RUNNER_MAX_AGE,
    });
    expect(body.checks.linearWebhook).toMatchObject({ ageMs: HOUR, maxAgeMs: HOUR });
    expect(body.checks.githubWebhook).toMatchObject({ ageMs: HOUR, maxAgeMs: HOUR });
  });

  test("disabled webhooks and no active runners do not prevent readiness", async () => {
    const db = await healthyStore();
    await seed(
      db,
      (q) => q.orm.delete(q.t.runner).where(eq(q.t.runner.status, "active")),
      (q) => q.orm.delete(q.t.syncCursor),
      (q) => q.orm.delete(q.t.githubDelivery),
    );
    const { status, body } = await probe(db, { webhooks: false });
    expect(status).toBe(200);
    expect(body.checks.runnerHeartbeats).toEqual({
      status: "skipped",
      reason: "no_active_runners",
    });
    expect(body.checks.linearWebhook).toEqual({ status: "skipped", reason: "not_configured" });
    expect(body.checks.githubWebhook).toEqual({ status: "skipped", reason: "not_configured" });
  });

  test("only providers with configured secrets require fresh deliveries", async () => {
    const db = await healthyStore();
    await seed(
      db,
      (q) => q.orm.delete(q.t.syncCursor),
      (q) => q.orm.delete(q.t.githubDelivery),
    );
    const server = startServer({
      store: db,
      port: 0,
      hostname: "127.0.0.1",
      webhooks: true,
      githubWebhookSecret: "test-github",
      healthNow: () => NOW,
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/health`);
      const body = (await response.json()) as HealthReport;
      expect(response.status).toBe(503);
      expect(body.failedChecks).toEqual(["githubWebhook"]);
      expect(body.checks.linearWebhook).toEqual({ status: "skipped", reason: "not_configured" });
    } finally {
      await server.stop(true);
    }
  });

  test("a fresh runner does not hide another runner's stale heartbeat", async () => {
    const db = await healthyStore();
    await seed(db, runner("active", NOW - RUNNER_MAX_AGE));
    const { status, body } = await probe(db);
    expect(status).toBe(503);
    expect(body.failedChecks).toEqual(["runnerHeartbeats"]);
    expect(body.checks.runnerHeartbeats).toMatchObject({ count: 1, ageMs: RUNNER_MAX_AGE });
  });

  test("an empty migrated database is ready when webhooks are off", async () => {
    expect((await probe(await emptyStore(), { webhooks: false })).status).toBe(200);
  });

  test("live probes report all failures and journal changes and recovery", async () => {
    const db = await healthyStore();
    const lines: string[] = [];
    const restore = setJournalSink((line) => lines.push(line));
    const server = startServer({
      store: db,
      port: 0,
      hostname: "127.0.0.1",
      webhooks: false,
      healthNow: () => NOW,
    });
    const url = `http://127.0.0.1:${server.port}/health`;
    try {
      expect((await fetch(url)).status).toBe(200);
      await seed(db, job("dead", null), outbox("dead"));
      const response = await fetch(url);
      expect(response.status).toBe(503);
      expect(((await response.json()) as HealthReport).failedChecks).toEqual([
        "deadJobs",
        "deadOutbox",
      ]);
      expect((await fetch(url)).status).toBe(503);
      await seed(
        db,
        (q) => q.orm.delete(q.t.job).where(eq(q.t.job.status, "dead")),
        (q) => q.orm.delete(q.t.outbox).where(eq(q.t.outbox.status, "dead")),
      );
      expect((await fetch(url)).status).toBe(200);
      expect(lines).toEqual(["health: failing checks: deadJobs,deadOutbox", "health: healthy"]);
    } finally {
      await server.stop(true);
      restore();
    }
  });

  test("due work with a quiet loop fails health while a busy or recent loop stays up", async () => {
    const db = await emptyStore();
    const dueAt = NOW - JOB_PROGRESS_STALE_MS;
    await enqueueJob(db, { queue: "work", runAt: dueAt, now: dueAt });
    const runAt = (at: number) =>
      seed(db, (q) => q.orm.update(q.t.job).set({ runAt: at }).where(eq(q.t.job.queue, "work")));
    const live = {
      polling: true,
      lastTickAt: NOW,
      lastClaimAt: NOW,
      inFlight: 0,
      workerCount: 1,
    };
    const probeLoop = (jobLoop: JobLoopLiveness) => probeWith(db, () => jobLoop);
    const idle = await probeLoop({ ...live, lastTickAt: dueAt, lastClaimAt: null });
    expect(idle.status).toBe(503);
    expect(idle.body.failedChecks).toEqual(["jobProgress"]);
    expect(idle.body.checks.jobProgress).toMatchObject({
      status: "failed",
      reason: "loop_idle",
      count: 1,
      ageMs: JOB_PROGRESS_STALE_MS,
      maxAgeMs: JOB_PROGRESS_STALE_MS,
    });

    const unclaimed = await probeLoop({ ...live, lastClaimAt: dueAt });
    expect(unclaimed.status).toBe(503);
    expect(unclaimed.body.checks.jobProgress).toMatchObject({
      status: "failed",
      reason: "due_unclaimed",
    });

    const recent = await probeLoop(live);
    expect(recent.status).toBe(200);
    expect(recent.body.checks.jobProgress).toMatchObject({ status: "ok", count: 1 });

    await runAt(NOW - JOB_PROGRESS_STALE_MS + 1);
    const notYet = await probeLoop({ ...live, lastTickAt: null, lastClaimAt: null });
    expect(notYet.status).toBe(200);
    expect(notYet.body.checks.jobProgress).toMatchObject({
      status: "ok",
      ageMs: JOB_PROGRESS_STALE_MS - 1,
    });

    await runAt(dueAt);
    const saturated = await probeLoop({
      ...live,
      lastTickAt: null,
      lastClaimAt: null,
      inFlight: 1,
    });
    expect(saturated.status).toBe(200);
    expect(saturated.body.checks.jobProgress).toMatchObject({ status: "ok", count: 1 });

    const starting = await probeWith(db, () => null);
    expect(starting.status).toBe(200);
    expect(starting.body.checks.jobProgress).toEqual({ status: "skipped", reason: "starting" });
  });

  test("a start without a reservation is not treated as stalled work", async () => {
    const db = await emptyStore();
    const dueAt = NOW - JOB_PROGRESS_STALE_MS;
    await enqueueJob(db, {
      queue: JOB_KIND.start,
      payload: { itemId: "unreserved" },
      runAt: dueAt,
      now: dueAt,
    });
    const { status, body } = await probeWith(db, () => ({
      polling: true,
      lastTickAt: null,
      lastClaimAt: null,
      inFlight: 0,
      workerCount: 1,
    }));
    expect(status).toBe(200);
    expect(body.checks.jobProgress).toEqual({ status: "ok", count: 0 });
  });
});

async function probeWith(db: Db, jobLoop: () => JobLoopLiveness | null) {
  const server = startServer({
    store: db,
    port: 0,
    hostname: "127.0.0.1",
    webhooks: false,
    healthNow: () => NOW,
    jobLoop,
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/health`);
    return { status: response.status, body: (await response.json()) as HealthReport };
  } finally {
    await server.stop(true);
  }
}
