import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { JOB_KIND } from "../src/core";
import {
  enqueueJob,
  JOB_PROGRESS_STALE_MS,
  migrate,
  openDatabase,
  setJournalSink,
  type JobLoopLiveness,
} from "../src/db";
import { RUNNER_ONLINE_MS } from "../src/runner-placement";
import { RUNNER_LEASE_GRACE_MS } from "../src/runner-protocol";
import { startServer, type HealthReport } from "../src/server";

const NOW = 10 * 60 * 60_000;
const HOUR = 60 * 60_000;
const RUNNER_MAX_AGE = RUNNER_ONLINE_MS + RUNNER_LEASE_GRACE_MS;

/** Minimal fake persistence with the same health columns as the migrated database. */
function fakeDatabase() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE job(status TEXT, locked_until INTEGER);
    CREATE TABLE outbox(status TEXT);
    CREATE TABLE runner(status TEXT, revoked_at INTEGER, last_seen_at INTEGER);
    CREATE TABLE sync_cursor(name TEXT, cursor_ms INTEGER);
    CREATE TABLE github_delivery(received_at INTEGER);
  `);
  db.run("INSERT INTO job VALUES('running', ?), ('done', 0), ('cancelled', 0)", [NOW + 1]);
  db.run("INSERT INTO outbox VALUES('pending'), ('sent'), ('dropped')");
  db.run("INSERT INTO runner VALUES('active', NULL, ?), ('paused', NULL, 0), ('revoked', 1, 0)", [
    NOW,
  ]);
  db.run("INSERT INTO sync_cursor VALUES('linear:webhook', ?)", [NOW]);
  db.run("INSERT INTO github_delivery VALUES(?)", [NOW]);
  return db;
}

async function probe(db: Database, options: { webhooks?: boolean; now?: number } = {}) {
  const server = startServer({
    db,
    port: 0,
    hostname: "127.0.0.1",
    webhooks: options.webhooks ?? true,
    linearWebhookSecret: "test-linear",
    githubWebhookSecret: "test-github",
    healthNow: () => options.now ?? NOW,
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

describe("server health", () => {
  test("reports every check, without caching a healthy result", async () => {
    const db = fakeDatabase();
    try {
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
      ]);
      expect(body.checks.jobProgress).toEqual({ status: "skipped", reason: "not_observed" });
      for (const [name, check] of Object.entries(body.checks)) {
        if (name === "jobProgress") continue;
        expect(check).toMatchObject({ status: "ok" });
      }
    } finally {
      db.close();
    }
  });

  test.each([
    ["jobLeases", "UPDATE job SET locked_until=? WHERE status='running'", NOW],
    ["jobLeases", "UPDATE job SET locked_until=NULL WHERE status='running'", null],
    ["deadJobs", "INSERT INTO job VALUES('dead', ?)", NOW],
    ["deadOutbox", "INSERT INTO outbox VALUES(?)", "dead"],
    [
      "runnerHeartbeats",
      "UPDATE runner SET last_seen_at=? WHERE status='active'",
      NOW - RUNNER_MAX_AGE,
    ],
    ["runnerHeartbeats", "UPDATE runner SET last_seen_at=NULL WHERE status=?", "active"],
    ["linearWebhook", "UPDATE sync_cursor SET cursor_ms=?", NOW - HOUR - 1],
    ["githubWebhook", "UPDATE github_delivery SET received_at=?", NOW - HOUR - 1],
    ["linearWebhook", "DELETE FROM sync_cursor WHERE name=?", "linear:webhook"],
    ["githubWebhook", "DELETE FROM github_delivery WHERE received_at=?", NOW],
  ])("returns 503 for %s (%s)", async (name, sql, value) => {
    const db = fakeDatabase();
    try {
      if (value === null) db.run(sql);
      else db.run(sql, [value]);
      const { status, body } = await probe(db);
      expect(status).toBe(503);
      expect(body.ok).toBe(false);
      expect(body.failedChecks).toEqual([name]);
      expect(body.checks[name]!.status).toBe("failed");
    } finally {
      db.close();
    }
  });

  test("database read failure returns 503 without exposing the error", async () => {
    const db = fakeDatabase();
    db.close();
    const { status, body } = await probe(db);
    expect(status).toBe(503);
    expect(body.failedChecks).toEqual(["database"]);
    expect(body.checks.database).toEqual({ status: "failed", reason: "unavailable" });
    expect(body.checks.jobLeases).toEqual({ status: "skipped", reason: "database_unavailable" });
  });

  test("checks use the webhook and heartbeat freshness boundaries", async () => {
    const db = fakeDatabase();
    try {
      db.run("UPDATE runner SET last_seen_at=? WHERE status='active'", [NOW - RUNNER_MAX_AGE + 1]);
      db.run("UPDATE sync_cursor SET cursor_ms=?", [NOW - HOUR]);
      db.run("UPDATE github_delivery SET received_at=?", [NOW - HOUR]);
      const { status, body } = await probe(db);
      expect(status).toBe(200);
      expect(body.checks.runnerHeartbeats).toMatchObject({
        ageMs: RUNNER_MAX_AGE - 1,
        maxAgeMs: RUNNER_MAX_AGE,
      });
      expect(body.checks.linearWebhook).toMatchObject({ ageMs: HOUR, maxAgeMs: HOUR });
      expect(body.checks.githubWebhook).toMatchObject({ ageMs: HOUR, maxAgeMs: HOUR });
    } finally {
      db.close();
    }
  });

  test("disabled webhooks and no active runners do not prevent readiness", async () => {
    const db = fakeDatabase();
    try {
      db.run("DELETE FROM runner WHERE status='active'");
      db.run("DELETE FROM sync_cursor");
      db.run("DELETE FROM github_delivery");
      const { status, body } = await probe(db, { webhooks: false });
      expect(status).toBe(200);
      expect(body.checks.runnerHeartbeats).toEqual({
        status: "skipped",
        reason: "no_active_runners",
      });
      expect(body.checks.linearWebhook).toEqual({ status: "skipped", reason: "not_configured" });
      expect(body.checks.githubWebhook).toEqual({ status: "skipped", reason: "not_configured" });
    } finally {
      db.close();
    }
  });

  test("only providers with configured secrets require fresh deliveries", async () => {
    const db = fakeDatabase();
    db.run("DELETE FROM sync_cursor");
    db.run("DELETE FROM github_delivery");
    const server = startServer({
      db,
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
      db.close();
    }
  });

  test("a fresh runner does not hide another runner's stale heartbeat", async () => {
    const db = fakeDatabase();
    try {
      db.run("INSERT INTO runner VALUES('active', NULL, ?)", [NOW - RUNNER_MAX_AGE]);
      const { status, body } = await probe(db);
      expect(status).toBe(503);
      expect(body.failedChecks).toEqual(["runnerHeartbeats"]);
      expect(body.checks.runnerHeartbeats).toMatchObject({ count: 1, ageMs: RUNNER_MAX_AGE });
    } finally {
      db.close();
    }
  });

  test("an empty migrated database is ready when webhooks are off", async () => {
    const db = openDatabase(":memory:");
    try {
      migrate(db);
      expect((await probe(db, { webhooks: false })).status).toBe(200);
    } finally {
      db.close();
    }
  });

  test("live probes report all failures and journal changes and recovery", async () => {
    const db = fakeDatabase();
    const lines: string[] = [];
    const restore = setJournalSink((line) => lines.push(line));
    const server = startServer({
      db,
      port: 0,
      hostname: "127.0.0.1",
      webhooks: false,
      healthNow: () => NOW,
    });
    const url = `http://127.0.0.1:${server.port}/health`;
    try {
      expect((await fetch(url)).status).toBe(200);
      db.run("INSERT INTO job VALUES('dead', NULL)");
      db.run("INSERT INTO outbox VALUES('dead')");
      const response = await fetch(url);
      expect(response.status).toBe(503);
      expect(((await response.json()) as HealthReport).failedChecks).toEqual([
        "deadJobs",
        "deadOutbox",
      ]);
      expect((await fetch(url)).status).toBe(503);
      db.run("DELETE FROM job WHERE status='dead'");
      db.run("DELETE FROM outbox WHERE status='dead'");
      expect((await fetch(url)).status).toBe(200);
      expect(lines).toEqual(["health: failing checks: deadJobs,deadOutbox", "health: healthy"]);
    } finally {
      await server.stop(true);
      restore();
      db.close();
    }
  });

  test("due work with a quiet loop fails health while a busy or recent loop stays up", async () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const dueAt = NOW - JOB_PROGRESS_STALE_MS;
    enqueueJob(db, { queue: "work", runAt: dueAt, now: dueAt });
    const live = {
      polling: true,
      lastTickAt: NOW,
      lastClaimAt: NOW,
      inFlight: 0,
      workerCount: 1,
    };
    const probeLoop = (jobLoop: JobLoopLiveness) => probeWith(db, () => jobLoop);
    try {
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

      db.run("UPDATE job SET run_at = ? WHERE queue = 'work'", [NOW - JOB_PROGRESS_STALE_MS + 1]);
      const notYet = await probeLoop({ ...live, lastTickAt: null, lastClaimAt: null });
      expect(notYet.status).toBe(200);
      expect(notYet.body.checks.jobProgress).toMatchObject({
        status: "ok",
        ageMs: JOB_PROGRESS_STALE_MS - 1,
      });

      db.run("UPDATE job SET run_at = ? WHERE queue = 'work'", [dueAt]);
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
    } finally {
      db.close();
    }
  });

  test("a start without a reservation is not treated as stalled work", async () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const dueAt = NOW - JOB_PROGRESS_STALE_MS;
    enqueueJob(db, {
      queue: JOB_KIND.start,
      payload: { itemId: "unreserved" },
      runAt: dueAt,
      now: dueAt,
    });
    try {
      const { status, body } = await probeWith(db, () => ({
        polling: true,
        lastTickAt: null,
        lastClaimAt: null,
        inFlight: 0,
        workerCount: 1,
      }));
      expect(status).toBe(200);
      expect(body.checks.jobProgress).toEqual({ status: "ok", count: 0 });
    } finally {
      db.close();
    }
  });
});

async function probeWith(db: Database, jobLoop: () => JobLoopLiveness | null) {
  const server = startServer({
    db,
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
