import { afterEach, expect, test } from "bun:test";
import { orphanedBlockers, readAlerts } from "../src/alerts";
import { insertInboxEvent, insertMetricMinutesSteps, type Db, type Q } from "../src/db";
import { seed, withoutForeignKeys } from "./pglite-fixtures";
import { tempStore } from "./pglite";

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 10, 26, 6, 0, 0);
let closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closers.map((close) => close()));
  closers = [];
});

async function store(): Promise<Db> {
  const opened = await tempStore();
  closers.push(opened.close);
  await withoutForeignKeys(opened.db);
  return opened.db;
}

async function ids(db: Db) {
  return (await readAlerts(db, NOW)).map((alert) => alert.id);
}

function requests(db: Db, route: string, status_class: string, counts: number[]) {
  return db.run((q) =>
    insertMetricMinutesSteps(
      q,
      counts.map((count, index) => ({
        minute: NOW - (index + 1) * MINUTE,
        name: "http.request",
        labels: { route, method: "POST", status_class },
        count,
        sum: count,
        max: 1,
        buckets: null,
        gauge: null,
      })),
    ),
  );
}

function failedJob(db: Db, itemId: string, attempts: number, lastError: string) {
  return seed(db, (q) =>
    q.orm.insert(q.t.job).values({
      queue: "item.run",
      payload: { itemId },
      runAt: NOW - 30 * MINUTE,
      status: "dead",
      attempts,
      lastError,
      createdAt: NOW - 60 * MINUTE,
      finishedAt: NOW - 5 * MINUTE,
    }),
  );
}

async function testTimeout(db: Db, id: string, finishedAt: number) {
  await db.run(function* (q: Q) {
    yield* q.exec(
      q.orm.insert(q.t.closeoutProgress).values({
        id,
        itemId: "item-a",
        taskId: "task",
        base: "main",
        head: "abc",
        policyDigest: "digest",
        startedAt: finishedAt - 30 * MINUTE,
        updatedAt: finishedAt,
      }),
    );
    yield* q.exec(
      q.orm.insert(q.t.closeoutStep).values({
        progressId: id,
        stepId: "test",
        kind: "command",
        state: "failed",
        command: "bun test",
        attempt: 1,
        ordinal: 0,
        startedAt: finishedAt - 30 * MINUTE,
        finishedAt,
        timedOut: 1,
      }),
    );
  });
}

function deadOutbox(db: Db, key: string, createdAt: number) {
  return seed(db, (q) =>
    q.orm.insert(q.t.outbox).values({
      target: "linear",
      op: "plan",
      idempotencyKey: key,
      payload: {},
      status: "dead",
      error: "Invalid plan",
      createdAt,
    }),
  );
}

async function idleRunner(db: Db, capacity: number, queuedAt: number) {
  await seed(
    db,
    (q) =>
      q.orm.insert(q.t.runner).values({
        id: "runner-1",
        workspaceId: "ws-1",
        ownerUserId: "user-1",
        name: "Runner",
        status: "active",
        createdAt: NOW - 24 * 60 * MINUTE,
        lastSeenAt: NOW - 1_000,
      }),
    (q) => q.orm.insert(q.t.runnerCapacity).values({ runnerId: "runner-1", capacity }),
    (q) =>
      q.orm.insert(q.t.workItemEvent).values({
        itemId: "item-a",
        version: 1,
        at: queuedAt,
        fromState: "queued",
        toState: "running",
        event: "started",
      }),
  );
}

test("runner_http_4xx fires at 30 4xx answers on one runner route in 10 minutes", async () => {
  const db = await store();
  await requests(db, "/v1/heartbeat", "4xx", [10, 10, 10]);
  await requests(db, "/v1/commands", "4xx", [29]);
  await requests(db, "/v1/events", "2xx", [500]);
  await requests(db, "/api/issues", "4xx", [500]);
  const alerts = await readAlerts(db, NOW);
  expect(alerts.map((alert) => alert.id)).toEqual(["runner_http_4xx:/v1/heartbeat"]);
  expect(alerts[0]).toMatchObject({ severity: "critical", count: 30, since: NOW - 3 * MINUTE });
  expect(alerts[0]!.title).toContain("/v1/heartbeat");
});

test("runner_http_4xx ignores answers older than 10 minutes", async () => {
  const db = await store();
  await requests(db, "/v1/heartbeat", "4xx", [...Array(10).fill(0), 100]);
  expect(await ids(db)).toEqual([]);
});

test("repeated_failure fires when an item's last 5 attempts failed with one error", async () => {
  const db = await store();
  await failedJob(db, "item-a", 5, "pull request already exists but could not be read");
  await failedJob(db, "item-b", 4, "Commit attribution rejected");
  const alerts = await readAlerts(db, NOW);
  expect(alerts.map((alert) => alert.id)).toEqual(["repeated_failure:item-a"]);
  expect(alerts[0]).toMatchObject({
    severity: "critical",
    count: 5,
    detail: "pull request already exists but could not be read",
  });
});

test("repeated_failure stays quiet when the errors differ", async () => {
  const db = await store();
  await failedJob(db, "item-a", 3, "first error");
  await failedJob(db, "item-a", 3, "second error");
  expect(await ids(db)).toEqual([]);
});

test("test_timeouts fires on 3 timed-out test steps in 2 hours, not on 2", async () => {
  const db = await store();
  await testTimeout(db, "p1", NOW - 10 * MINUTE);
  await testTimeout(db, "p2", NOW - 60 * MINUTE);
  await testTimeout(db, "p3", NOW - 3 * 60 * MINUTE);
  expect(await ids(db)).toEqual([]);
  await testTimeout(db, "p4", NOW - 100 * MINUTE);
  const alerts = await readAlerts(db, NOW);
  expect(alerts).toEqual([
    expect.objectContaining({ id: "test_timeouts", severity: "warning", count: 3 }),
  ]);
});

test("dead_outbox names the op and the error of a row that died in the last hour", async () => {
  const db = await store();
  await deadOutbox(db, "old", NOW - 61 * MINUTE);
  expect(await ids(db)).toEqual([]);
  await deadOutbox(db, "new", NOW - 5 * MINUTE);
  const alerts = await readAlerts(db, NOW);
  expect(alerts).toEqual([
    expect.objectContaining({ severity: "warning", detail: "Invalid plan", count: 1 }),
  ]);
  expect(alerts[0]!.title).toContain("plan");
});

test("idle_capacity fires on 2 free slots and no queued item for 30 minutes", async () => {
  const db = await store();
  await idleRunner(db, 2, NOW - 31 * MINUTE);
  expect(await readAlerts(db, NOW)).toEqual([
    expect.objectContaining({ id: "idle_capacity", severity: "info", count: 2 }),
  ]);
});

test("idle_capacity stays quiet with one free slot or a recent queue", async () => {
  const one = await store();
  await idleRunner(one, 1, NOW - 31 * MINUTE);
  expect(await ids(one)).toEqual([]);
  const recent = await store();
  await idleRunner(recent, 2, NOW - 29 * MINUTE);
  expect(await ids(recent)).toEqual([]);
});

test("alerts are listed newest first", async () => {
  const db = await store();
  await deadOutbox(db, "new", NOW - 5 * MINUTE);
  await requests(db, "/v1/heartbeat", "4xx", [0, 0, 0, 0, 0, 0, 0, 40]);
  const alerts = await readAlerts(db, NOW);
  expect(alerts.map((alert) => alert.since)).toEqual([NOW - 5 * MINUTE, NOW - 8 * MINUTE]);
});

function inbox(db: Db, key: string, receivedAt: number) {
  return insertInboxEvent(db, {
    dedupeKey: key,
    deliveryId: null,
    source: "webhook",
    action: "created",
    sessionId: key,
    issueId: null,
    activityId: null,
    body: null,
    signal: null,
    updatedAtMs: receivedAt,
    payload: "{}",
    receivedAt,
  });
}

test("intake_backlog warns after 10 minutes of unhandled intake and turns critical at 30", async () => {
  const db = await store();
  await inbox(db, "s1", NOW - 10 * MINUTE);
  await inbox(db, "s2", NOW - MINUTE);
  expect(await ids(db)).toEqual([]);
  await inbox(db, "s0", NOW - 10 * MINUTE - 1);
  expect(await readAlerts(db, NOW)).toEqual([
    expect.objectContaining({ id: "intake_backlog", severity: "warning", count: 3 }),
  ]);
  await inbox(db, "s3", NOW - 30 * MINUTE);
  expect(await readAlerts(db, NOW)).toEqual([
    expect.objectContaining({ id: "intake_backlog", severity: "critical", count: 4 }),
  ]);
});

const CANCELLED_AT = Date.UTC(2026, 10, 26, 4, 56, 0);

function orphan(blocked: string, heldMinutes: number) {
  return {
    blocker: "PAS-2609",
    state: "cancelled",
    endedAt: CANCELLED_AT,
    blocked,
    heldSince: NOW - heldMinutes * MINUTE,
  };
}

test("orphaned_blocker fires after 30 minutes held by a blocker whose latest item is cancelled", () => {
  expect(orphanedBlockers([orphan("PAS-2610", 31)], NOW)).toEqual([
    expect.objectContaining({
      id: "orphaned_blocker:PAS-2609",
      severity: "warning",
      title: "PAS-2609 has no live Paws item (cancelled 04:56) and blocks PAS-2610",
      count: 1,
    }),
  ]);
  expect(orphanedBlockers([orphan("PAS-2610", 29)], NOW)).toEqual([]);
});

test("orphaned_blocker sends one alert per blocker and lists at most 5 blocked items", () => {
  const two = orphanedBlockers([orphan("PAS-2610", 40), orphan("PAS-2611", 35)], NOW);
  expect(two.map((alert) => alert.title)).toEqual([
    "PAS-2609 has no live Paws item (cancelled 04:56) and blocks PAS-2610, PAS-2611",
  ]);
  const seven = orphanedBlockers(
    [1, 2, 3, 4, 5, 6, 7].map((n) => orphan(`PAS-270${n}`, 40)),
    NOW,
  );
  expect(seven[0]!.title).toEndWith("PAS-2704, PAS-2705 and 2 more");
});

async function blockedBy(db: Db, blockerState: string) {
  const item = (id: string, issue: string, state: string, createdAt: number) =>
    seed(db, (q) =>
      q.orm.insert(q.t.workItem).values({
        id,
        delegationId: "delegation",
        linearIssueId: issue,
        linearIdentifier: issue.toUpperCase(),
        title: issue,
        state,
        branchName: `paws/${id}`,
        position: 0,
        createdAt,
      }),
    );
  await item("item-old", "pas-2609", "cancelled", NOW - 300 * MINUTE);
  await item("item-new", "pas-2609", blockerState, NOW - 200 * MINUTE);
  await item("item-held", "pas-2610", "queued", NOW - 100 * MINUTE);
  await seed(
    db,
    (q) =>
      q.orm.insert(q.t.workItemEvent).values({
        itemId: "item-new",
        version: 1,
        at: CANCELLED_AT,
        fromState: "running",
        toState: blockerState,
        event: "cancelled",
      }),
    (q) =>
      q.orm
        .insert(q.t.taskBlock)
        .values({ blockerLinearIssueId: "pas-2609", blockedLinearIssueId: "pas-2610" }),
    (q) =>
      q.orm
        .insert(q.t.itemHold)
        .values({ itemId: "item-held", reason: "blocked", blockers: ["PAS-2609"] }),
  );
}

test("readAlerts raises orphaned_blocker only while the blocker's latest item is not open", async () => {
  for (const [state, expected] of [
    ["cancelled", ["orphaned_blocker:PAS-2609"]],
    ["running", []],
  ]) {
    const db = await store();
    await blockedBy(db, state as string);
    expect(await ids(db)).toEqual(expected as string[]);
  }
});
