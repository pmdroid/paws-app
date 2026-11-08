import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  acknowledgeRunnerCommandSteps,
  assignRunnerWorkSteps,
  availableRunnerIdentitySteps,
  confirmRunnerWorkSteps,
  confirmRunnerWorkTeardownSteps,
  deleteRunnerWorkGrantsSteps,
  deliverableRunnerCommandsSteps,
  endRunnerWorkSteps,
  extendRunnerWorkLeaseSteps,
  finishRunnerWorkSteps,
  insertRunnerCommandSteps,
  insertRunnerEventSteps,
  insertRunnerWorkGrantSteps,
  loseRunnerWorkSteps,
  noteRunnerLiveReportSteps,
  noteRunnerSeenSteps,
  noteRunnerTerminationsSteps,
  openRunnerAssignmentsSteps,
  runnerCheckpointPendingSteps,
  runnerCommandAcknowledgedBySteps,
  runnerCommandEnvelopeSteps,
  runnerResultRecordedSteps,
  runnerWorkAssignmentSteps,
  runnerWorkGrantValidSteps,
  runnerWorkStillReportedSteps,
  setRunnerWorkLastSequenceSteps,
  storedRunnerEventSteps,
  workspaceInLinearOrganizationSteps,
  workspaceSessionRepositoryAllowedSteps,
  type Db,
} from "../src/db";
import { forEachDialect, seed, withoutForeignKeys, type DialectDb } from "./dialects";
import { seedCommand, seedResult, seedRun, seedRunner, seedWork } from "./runner-rows";

const open: DialectDb[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

async function connected(connect: () => Promise<DialectDb>) {
  const handle = await connect();
  open.push(handle);
  await withoutForeignKeys(handle.db);
  return handle.db;
}

function work(db: Db, runId = "run") {
  return db.run(function* (q) {
    const row = yield* q.one(
      q.orm.select().from(q.t.runnerWork).where(eq(q.t.runnerWork.runId, runId)),
    );
    return row!;
  });
}

function runnerRow(db: Db, id = "box") {
  return db.run(function* (q) {
    const row = yield* q.one(q.orm.select().from(q.t.runner).where(eq(q.t.runner.id, id)));
    return row!;
  });
}

function member(db: Db, row: { active?: number; revokedAt?: number } = {}) {
  return seed(db, (q) =>
    q.orm.insert(q.t.workspaceMember).values({
      workspaceId: "acme",
      userId: "owner",
      role: "admin",
      source: "linear",
      active: 1,
      checkedAt: 0,
      ...row,
    }),
  );
}

const key = { runId: "run", generation: 1, sequence: 1 };
const sealed = {
  payload: JSON.stringify("c2VhbGVk"),
  keyId: "key",
  payloadSha256: "sha",
  type: "handover",
  handedOver: 1,
  reason: "drain",
};

forEachDialect((connect) => {
  test("an assignment reads back, and only open ones are listed", async () => {
    const db = await connected(connect);
    await seedWork(db, "run", "box", { leaseUntil: 9 });
    await seedWork(db, "done", "box", { endedAt: 5 });
    await seedWork(db, "elsewhere", "other");
    expect(await db.run((q) => runnerWorkAssignmentSteps(q, "run"))).toEqual({
      runId: "run",
      runnerId: "box",
      workspaceId: "acme",
      generation: 1,
      runnerFence: 0,
      commandId: "command-run",
      leaseUntil: 9,
      lastSequence: 0,
      endedAt: null,
    });
    expect(await db.run((q) => runnerWorkAssignmentSteps(q, "missing"))).toBeNull();
    const rows = await db.run((q) => openRunnerAssignmentsSteps(q, "box"));
    expect(rows.map((row) => row.runId)).toEqual(["run"]);
  });

  test("a heartbeat confirmation counts as still reported only from the latest report", async () => {
    const db = await connected(connect);
    await seedRunner(db, "box", { liveReportedAt: 10 });
    await seedRunner(db, "quiet");
    await seedWork(db, "run", "box");
    await seedWork(db, "silent", "quiet");
    const reported = (runnerId: string, runId: string) =>
      db.run((q) => runnerWorkStillReportedSteps(q, runnerId, runId));
    expect(await reported("box", "run")).toBe(false);
    await db.run((q) => confirmRunnerWorkSteps(q, { runId: "run", generation: 1, at: 9 }));
    expect(await reported("box", "run")).toBe(false);
    await db.run((q) =>
      confirmRunnerWorkSteps(q, { runId: "run", generation: 1, at: 10, runnerId: "other" }),
    );
    expect((await work(db)).confirmedAt).toBe(9);
    await db.run((q) =>
      confirmRunnerWorkSteps(q, { runId: "run", generation: 1, at: 10, runnerId: "box" }),
    );
    expect(await reported("box", "run")).toBe(true);
    expect(await reported("other", "run")).toBe(false);
    await db.run((q) => confirmRunnerWorkSteps(q, { runId: "silent", generation: 1, at: 11 }));
    expect(await reported("quiet", "silent")).toBe(false);
  });

  test("a result counts only for its own generation and command", async () => {
    const db = await connected(connect);
    await seedResult(db, "run", "command", { ok: true });
    const recorded = (generation: number, commandId: string) =>
      db.run((q) => runnerResultRecordedSteps(q, { runId: "run", generation, commandId }));
    expect(await recorded(1, "command")).toBe(true);
    expect(await recorded(2, "command")).toBe(false);
    expect(await recorded(1, "other")).toBe(false);
  });

  test("a stored command returns its envelope, acknowledgement and checkpoint state", async () => {
    const db = await connected(connect);
    await db.run((q) =>
      insertRunnerCommandSteps(q, {
        id: "c1",
        runnerId: "box",
        runId: "run",
        generation: 1,
        kind: "checkpoint",
        envelope: { keyId: "k", payload: "p" },
        expiresAt: 100,
      }),
    );
    await seedCommand(db, "c2", {
      runnerId: "box",
      runId: "other",
      kind: "run",
      acknowledgedAt: 7,
    });
    const envelope = await db.run((q) => runnerCommandEnvelopeSteps(q, "c1"));
    expect(JSON.parse(envelope!)).toEqual({ keyId: "k", payload: "p" });
    expect(await db.run((q) => runnerCommandEnvelopeSteps(q, "missing"))).toBeNull();

    const pending = (runId: string, now: number) =>
      db.run((q) => runnerCheckpointPendingSteps(q, runId, now));
    expect(await pending("run", 99)).toBe(true);
    expect(await pending("run", 100)).toBe(false);
    expect(await pending("other", 0)).toBe(false);

    const by = (id: string, at: number) =>
      db.run((q) => runnerCommandAcknowledgedBySteps(q, id, at));
    expect(await by("c2", 7)).toBe(true);
    expect(await by("c2", 6)).toBe(false);
    expect(await by("c1", 100)).toBe(false);
  });

  test("delivery skips acknowledged, expired, earlier and unleased commands", async () => {
    const db = await connected(connect);
    await seedWork(db, "held", "box", { leaseUntil: 50 });
    await seedWork(db, "lapsed", "box", { leaseUntil: 5 });
    await seedWork(db, "moved", "other", { leaseUntil: 50 });
    const commands: [string, Parameters<typeof seedCommand>[2]][] = [
      ["probe", { runnerId: "box", runId: "free", kind: "probe" }],
      ["held", { runnerId: "box", runId: "held", kind: "run" }],
      ["lapsed", { runnerId: "box", runId: "lapsed", kind: "run" }],
      ["moved", { runnerId: "box", runId: "moved", kind: "review" }],
      ["old", { runnerId: "box", runId: "held", kind: "run", generation: 2 }],
      ["acked", { runnerId: "box", runId: "free", kind: "cancel", acknowledgedAt: 1 }],
      ["expired", { runnerId: "box", runId: "free", kind: "probe", expiresAt: 5 }],
      ["foreign", { runnerId: "other", runId: "free", kind: "probe" }],
    ];
    for (const [id, row] of commands) await seedCommand(db, id, { envelope: { id }, ...row });
    const page = (after: number) =>
      db.run((q) =>
        deliverableRunnerCommandsSteps(q, { runnerId: "box", now: 10, after, leaseCutoff: 10 }),
      );
    const rows = await page(0);
    expect(rows.map((row) => JSON.parse(row.envelope).id)).toEqual(["probe", "held"]);
    expect(rows[1]).toMatchObject({ runId: "held", generation: 1 });
    expect((await page(rows[0]!.ordinal)).map((row) => JSON.parse(row.envelope).id)).toEqual([
      "held",
    ]);
  });

  test("an acknowledgement counts its command and keeps the first time", async () => {
    const db = await connected(connect);
    await seedCommand(db, "c", { runnerId: "box", runId: "run", kind: "run" });
    const acknowledge = (runnerId: string, id: string, now: number) =>
      db.run((q) => acknowledgeRunnerCommandSteps(q, runnerId, id, now));
    expect(await acknowledge("other", "c", 1)).toBe(0);
    expect(await acknowledge("box", "missing", 1)).toBe(0);
    expect(await acknowledge("box", "c", 5)).toBe(1);
    expect(await acknowledge("box", "c", 9)).toBe(1);
    expect(await db.run((q) => runnerCommandAcknowledgedBySteps(q, "c", 5))).toBe(true);
  });

  test("a new assignment replaces the previous one and resets its progress", async () => {
    const db = await connected(connect);
    await seedRun(db, "run", "item");
    const assignment = {
      runId: "run",
      runnerId: "box",
      workspaceId: "acme",
      generation: 1,
      runnerFence: 1,
      commandId: "first",
      leaseUntil: 10,
    };
    await db.run((q) => assignRunnerWorkSteps(q, assignment));
    await db.run((q) => setRunnerWorkLastSequenceSteps(q, "run", 4));
    await db.run((q) => loseRunnerWorkSteps(q, "run", 1, 8));
    await db.run((q) => confirmRunnerWorkSteps(q, { runId: "run", generation: 1, at: 8 }));
    await db.run((q) =>
      confirmRunnerWorkTeardownSteps(q, {
        runnerId: "box",
        runId: "run",
        generation: 1,
        commandId: "first",
        at: 8,
      }),
    );
    expect(await work(db)).toMatchObject({
      lastSequence: 4,
      endedAt: 8,
      lostAt: 8,
      confirmedAt: 8,
      teardownConfirmedAt: 8,
    });
    await db.run((q) =>
      assignRunnerWorkSteps(q, {
        ...assignment,
        runnerId: "next",
        generation: 2,
        runnerFence: 3,
        commandId: "second",
        leaseUntil: 20,
      }),
    );
    expect(await work(db)).toMatchObject({
      runnerId: "next",
      generation: 2,
      runnerFence: 3,
      commandId: "second",
      leaseUntil: 20,
      lastSequence: 0,
      consumedSequence: 0,
      endedAt: null,
      confirmedAt: null,
      lostAt: null,
      teardownConfirmedAt: null,
    });
  });

  test("a lease only moves forward", async () => {
    const db = await connected(connect);
    await seedWork(db, "run", "box", { leaseUntil: 10 });
    await db.run((q) => extendRunnerWorkLeaseSteps(q, "run", 5));
    expect((await work(db)).leaseUntil).toBe(10);
    await db.run((q) => extendRunnerWorkLeaseSteps(q, "run", 20));
    expect((await work(db)).leaseUntil).toBe(20);
  });

  test("ending and finishing are bound to the generation", async () => {
    const db = await connected(connect);
    await seedWork(db, "run", "box", { generation: 2 });
    await db.run((q) => endRunnerWorkSteps(q, "run", 1, 5));
    expect((await work(db)).endedAt).toBeNull();
    expect(await db.run((q) => finishRunnerWorkSteps(q, "run", 1, 5))).toBe(0);
    expect(await db.run((q) => finishRunnerWorkSteps(q, "run", 2, 6))).toBe(1);
    expect(await work(db)).toMatchObject({ endedAt: 6, teardownConfirmedAt: 6 });
    expect(await db.run((q) => finishRunnerWorkSteps(q, "run", 2, 7))).toBe(0);
    await db.run((q) => endRunnerWorkSteps(q, "run", 2, 9));
    expect((await work(db)).endedAt).toBe(9);
  });

  test("teardown is confirmed by the work's command or a cancel sent for it, once", async () => {
    const db = await connected(connect);
    await seedWork(db, "run", "box", { commandId: "work-command" });
    await seedCommand(db, "cancel", { runnerId: "box", runId: "run", kind: "cancel" });
    await seedCommand(db, "probe", { runnerId: "box", runId: "run", kind: "probe" });
    await seedCommand(db, "stale-cancel", {
      runnerId: "box",
      runId: "run",
      kind: "cancel",
      generation: 2,
    });
    const confirm = (commandId: string, at: number, runnerId = "box") =>
      db.run((q) =>
        confirmRunnerWorkTeardownSteps(q, { runnerId, runId: "run", generation: 1, commandId, at }),
      );
    await confirm("probe", 1);
    await confirm("stale-cancel", 2);
    await confirm("cancel", 3, "other");
    expect((await work(db)).teardownConfirmedAt).toBeNull();
    await confirm("cancel", 4);
    expect((await work(db)).teardownConfirmedAt).toBe(4);
    await confirm("work-command", 5);
    expect((await work(db)).teardownConfirmedAt).toBe(4);
  });

  test("a grant is valid for its own token, generation and lifetime until deleted", async () => {
    const db = await connected(connect);
    const grant = { tokenHash: "hash", runId: "run", generation: 1, expiresAt: 10 };
    await db.run((q) => insertRunnerWorkGrantSteps(q, grant));
    const valid = (over: Partial<typeof grant>, at = 9) =>
      db.run((q) => runnerWorkGrantValidSteps(q, { ...grant, ...over }, at));
    expect(await valid({})).toBe(true);
    expect(await valid({}, 10)).toBe(false);
    expect(await valid({ tokenHash: "other" })).toBe(false);
    expect(await valid({ runId: "other" })).toBe(false);
    expect(await valid({ generation: 2 })).toBe(false);
    await db.run((q) => deleteRunnerWorkGrantsSteps(q, "run"));
    expect(await valid({})).toBe(false);
  });

  test("a sealed event round-trips with its JSON string payload", async () => {
    const db = await connected(connect);
    await db.run((q) => insertRunnerEventSteps(q, key, sealed, 5));
    expect(await db.run((q) => storedRunnerEventSteps(q, key))).toEqual({
      ...key,
      payload: sealed.payload,
      keyId: "key",
      payloadSha256: "sha",
    });
    const missing = { ...key, sequence: 2 };
    expect(await db.run((q) => storedRunnerEventSteps(q, missing))).toBeNull();
  });

  test("a runner identity needs a live runner and a usable owner", async () => {
    const db = await connected(connect);
    await seedRunner(db, "box", { status: "draining" });
    await seedRunner(db, "gone", { revokedAt: 1 });
    await seedRunner(db, "revoked", { status: "revoked" });
    const identity = (id: string) => db.run((q) => availableRunnerIdentitySteps(q, id));
    expect(await identity("box")).toBeNull();
    await member(db);
    expect(await identity("box")).toEqual({
      workspaceId: "acme",
      userId: "owner",
      fence: 0,
      status: "draining",
    });
    expect(await identity("gone")).toBeNull();
    expect(await identity("revoked")).toBeNull();
    expect(await identity("missing")).toBeNull();
  });

  test("a runner identity is unavailable once its owner is revoked", async () => {
    const db = await connected(connect);
    await seedRunner(db, "box");
    await member(db, { revokedAt: 1 });
    expect(await db.run((q) => availableRunnerIdentitySteps(q, "box"))).toBeNull();
  });

  test("heartbeat stamps land on the runner, and terminations keep the first time", async () => {
    const db = await connected(connect);
    await seedRunner(db, "box");
    await db.run((q) => noteRunnerSeenSteps(q, "box", 3));
    await db.run((q) => noteRunnerLiveReportSteps(q, "box", 4));
    await db.run((q) => noteRunnerTerminationsSteps(q, "box", 5));
    await db.run((q) => noteRunnerTerminationsSteps(q, "box", 6));
    expect(await runnerRow(db)).toMatchObject({
      lastSeenAt: 3,
      liveReportedAt: 4,
      terminationsSince: 5,
    });
  });

  test("a workspace matches only its Linear organization", async () => {
    const db = await connected(connect);
    await seed(db, (q) =>
      q.orm
        .insert(q.t.workspace)
        .values({ id: "acme", linearOrganizationId: "org", name: "Acme", createdAt: 0 }),
    );
    const matches = (organizationId: string | null) =>
      db.run((q) => workspaceInLinearOrganizationSteps(q, "acme", organizationId));
    expect(await matches("org")).toBe(true);
    expect(await matches("other")).toBe(false);
    expect(await matches(null)).toBe(false);
  });

  test("a session's repository is allowed by its team's links, or the catalog without links", async () => {
    const db = await connected(connect);
    await seed(
      db,
      (q) =>
        q.orm
          .insert(q.t.workspace)
          .values({ id: "acme", linearOrganizationId: "org", name: "Acme", createdAt: 0 }),
      (q) =>
        q.orm.insert(q.t.linearSession).values([
          { sessionId: "linked", organizationId: "org", teamId: "team", createdAt: 0 },
          { sessionId: "open", organizationId: "org", teamId: "free", createdAt: 0 },
          { sessionId: "teamless", organizationId: "org", createdAt: 0 },
          { sessionId: "foreign", organizationId: "elsewhere", teamId: "free", createdAt: 0 },
        ]),
      (q) =>
        q.orm
          .insert(q.t.workspaceRepository)
          .values({ workspaceId: "acme", repository: "Acme/Linked", teamId: "team" }),
      (q) =>
        q.orm.insert(q.t.repositoryCatalog).values({
          repository: "acme/catalog",
          owner: "acme",
          repo: "catalog",
          remoteUrl: "https://example.test/acme/catalog.git",
          defaultBranch: "main",
          refreshedAt: 0,
        }),
    );
    const allowed = (sessionId: string, repository: string) =>
      db.run((q) => workspaceSessionRepositoryAllowedSteps(q, "acme", sessionId, repository));
    expect(await allowed("linked", "ACME/linked")).toBe(true);
    expect(await allowed("linked", "acme/catalog")).toBe(false);
    expect(await allowed("open", "Acme/Catalog")).toBe(true);
    expect(await allowed("open", "acme/linked")).toBe(false);
    expect(await allowed("teamless", "acme/catalog")).toBe(true);
    expect(await allowed("foreign", "acme/catalog")).toBe(false);
  });
});
