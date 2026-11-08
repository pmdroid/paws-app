import { afterEach, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  activeRunnerIdsSteps,
  pinnedSlotsReservedSteps,
  recordRunnerCapacitySteps,
  releasePinnedSlotSteps,
  runnerCancelPendingSteps,
  runnerConversationLaneSteps,
  RunnerConcurrencyError,
  runnerHasCapacitySteps,
  runnerHelperAvailabilitySteps,
  runnerOccupancySteps,
  runnerSlotFreeSteps,
  runnerSlotsHeldBetweenCommandsSteps,
  runTeardownOwnerSteps,
  savePinnedSlotsSteps,
  setRunnerConcurrencySteps,
  slotWaitRunnersSteps,
  unfinishedConversationHelpersSteps,
  yieldFindingGroupHelpersSteps,
  type Db,
  type Q,
} from "../src/db";
import { forEachDialect, json, seed, withoutForeignKeys, type DialectDb } from "./dialects";
import { seedRun, seedRunner } from "./runner-rows";

const NOW = 1_000_000_000;

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

function seedCapacity(
  db: Db,
  runnerId: string,
  row: { capacity?: number; ceiling?: number; desired?: number; conversation?: number } = {},
) {
  return seed(db, (q) =>
    q.orm.insert(q.t.runnerCapacity).values({ runnerId, capacity: 4, ...row }),
  );
}

type WorkRow = {
  leaseUntil?: number;
  endedAt?: number;
  teardownConfirmedAt?: number;
  generation?: number;
};

function seedWork(db: Db, runId: string, runnerId: string, row: WorkRow = {}) {
  return seed(db, (q) =>
    q.orm.insert(q.t.runnerWork).values({
      runId,
      runnerId,
      workspaceId: "acme",
      generation: 1,
      runnerFence: 0,
      commandId: `command-${runId}`,
      leaseUntil: NOW + 60_000,
      ...row,
    }),
  );
}

function seedResult(db: Db, runId: string) {
  return seed(db, (q) =>
    q.orm.insert(q.t.runnerResult).values({
      runId,
      generation: 1,
      commandId: `command-${runId}`,
      payload: json(db, {}),
      receivedAt: 0,
    }),
  );
}

function envelope(command: { type: string; purpose?: string }) {
  return { payload: Buffer.from(JSON.stringify(command)).toString("base64url"), signature: "s" };
}

const FINDING_GROUPS = { type: "helper", purpose: "finding_groups" };

function seedHelper(
  db: Db,
  id: string,
  row: { purpose?: string; result?: unknown; endedAt?: number; expiresAt?: number } = {},
  command: { type: string; purpose?: string } = FINDING_GROUPS,
) {
  const { result, ...rest } = row;
  return seed(db, (q) =>
    q.orm.insert(q.t.runnerHelper).values({
      id,
      runnerId: "box",
      workspaceId: "acme",
      sessionId: `session-${id}`,
      sessionGeneration: 1,
      runnerFence: 0,
      envelope: json(db, envelope(command)),
      expiresAt: NOW + 60_000,
      ...(result === undefined ? {} : { result: json(db, result) }),
      ...rest,
    }),
  );
}

function seedRetro(db: Db, commandId: string, releasedAt?: number) {
  return seed(db, (q) =>
    q.orm.insert(q.t.retroDispatch).values({
      commandId,
      retroId: `retro-${commandId}`,
      attempt: 1,
      workspaceId: "acme",
      runnerId: "box",
      runnerFence: 0,
      command: json(db, {}),
      envelope: json(db, {}),
      createdAt: 0,
      issuedAt: 0,
      expiresAt: 1,
      ...(releasedAt === undefined ? {} : { releasedAt, releaseReason: "teardown" }),
    }),
  );
}

function seedJob(
  db: Db,
  id: number,
  payload: Record<string, unknown>,
  row: { queue?: string; status?: string; lockedUntil?: number } = {},
) {
  return seed(db, (q) =>
    q.orm.insert(q.t.job).values({
      id,
      queue: "run.resume",
      payload: json(db, payload),
      runAt: 0,
      createdAt: 0,
      ...row,
    }),
  );
}

async function payloadOf(db: Db, id: number): Promise<Record<string, unknown>> {
  const row = await db.run((q: Q) =>
    q.one(q.orm.select({ payload: q.t.job.payload }).from(q.t.job).where(eq(q.t.job.id, id))),
  );
  const stored = row!.payload;
  return (typeof stored === "string" ? JSON.parse(stored) : stored) as Record<string, unknown>;
}

const occupancy = (db: Db, excludeRunId = "") =>
  db.run((q) => runnerOccupancySteps(q, "box", NOW, excludeRunId));

forEachDialect((connect) => {
  test("capacity is the lower of applied and desired, and one when unreported", async () => {
    const db = await connected(connect);
    expect(await occupancy(db)).toEqual({ capacity: 1, occupied: 0 });
    await seedCapacity(db, "box", { capacity: 4, desired: 2 });
    expect(await occupancy(db)).toEqual({ capacity: 2, occupied: 0 });
    await seedCapacity(db, "other", { capacity: 3 });
    expect(await db.run((q) => runnerOccupancySteps(q, "other", NOW))).toEqual({
      capacity: 3,
      occupied: 0,
    });
  });

  test("occupancy counts leased work, work helpers, retros and unresolved teardown", async () => {
    const db = await connected(connect);
    await seedRunner(db, "box");
    await seedCapacity(db, "box");
    await seedWork(db, "leased", "box");
    await seedWork(db, "expired", "box", { leaseUntil: 0, endedAt: 1, teardownConfirmedAt: 2 });
    await seedWork(db, "tearing-down", "box", { endedAt: 1 });
    await seedHelper(db, "work");
    await seedHelper(db, "conversation", { purpose: "conversation" });
    await seedHelper(db, "ended", { endedAt: 1 });
    await seedHelper(db, "stale", { expiresAt: NOW });
    await seedRetro(db, "retro-live");
    await seedRetro(db, "retro-released", 1);
    expect(await occupancy(db)).toEqual({ capacity: 4, occupied: 4 });
    expect(await occupancy(db, "leased")).toEqual({ capacity: 4, occupied: 3 });
    const has = (extra: number) =>
      db.run((q) => runnerHasCapacitySteps(q, "box", NOW, "leased", extra));
    expect(await has(0)).toBe(true);
    expect(await has(1)).toBe(false);
  });

  test("slots stay held between commands until CI waits or the run is excluded", async () => {
    const db = await connected(connect);
    await seedRunner(db, "box");
    await seedRun(db, "run", "item");
    await seedWork(db, "run", "box", { endedAt: 1, teardownConfirmedAt: 2 });
    const held = (excludeRunId = "") =>
      db.run((q) => runnerSlotsHeldBetweenCommandsSteps(q, "box", NOW, excludeRunId));
    expect(await held()).toBe(1);
    expect(await held("run")).toBe(0);

    await seedRun(db, "finished", "item-2", "ended");
    await seedWork(db, "finished", "box", { endedAt: 1, teardownConfirmedAt: 2 });
    await seedRun(db, "live", "item-3");
    await seedWork(db, "live", "box");
    expect(await held()).toBe(1);

    await seedRun(db, "lapsed", "item-4");
    await seedWork(db, "lapsed", "box", { leaseUntil: 0 });
    expect(await held()).toBe(1);
    await seedResult(db, "lapsed");
    expect(await held()).toBe(2);

    await seedJob(db, 1, { itemId: "item", awakeWait: { kind: "ci" } }, { status: "running" });
    expect(await held()).toBe(1);
  });

  test("active runners are live, not revoked and seen within the minute", async () => {
    const db = await connected(connect);
    await seedRunner(db, "seen", { lastSeenAt: NOW });
    await seedRunner(db, "quiet", { lastSeenAt: NOW - 60_000 });
    await seedRunner(db, "revoked", { lastSeenAt: NOW, revokedAt: 1 });
    await seedRunner(db, "paused", { lastSeenAt: NOW, status: "paused" });
    expect(await db.run((q) => activeRunnerIdsSteps(q, NOW))).toEqual(["seen"]);
  });

  test("a waiting run widens to active runners only before it is placed", async () => {
    const db = await connected(connect);
    await seedRunner(db, "known", { lastSeenAt: NOW });
    await seedRunner(db, "online", { lastSeenAt: NOW });
    await seedRunner(db, "new", { lastSeenAt: NOW });
    const wait = (runnerIds: string[]) => ({
      since: 0,
      attempt: 1,
      runnerIds,
      online: ["online"],
    });
    const runners = (runId: string, runnerIds: string[]) =>
      db.run((q) => slotWaitRunnersSteps(q, runId, wait(runnerIds), NOW));
    expect(await runners("run", [])).toEqual([]);
    expect(await runners("run", ["known"])).toEqual(["known", "new"]);
    await seedWork(db, "run", "known");
    expect(await runners("run", ["known"])).toEqual(["known"]);
  });

  test("a slot is free on a named runner or, with none named, any active runner", async () => {
    const db = await connected(connect);
    await seedRunner(db, "busy", { lastSeenAt: NOW });
    await seedCapacity(db, "busy", { capacity: 1 });
    await seedWork(db, "run", "busy");
    const free = (ids: string[], runId = "") =>
      db.run((q) => runnerSlotFreeSteps(q, ids, NOW, runId));
    expect(await free(["busy"])).toBe(false);
    expect(await free([])).toBe(false);
    expect(await free(["busy"], "run")).toBe(true);
    await seedRunner(db, "idle", { lastSeenAt: NOW });
    expect(await free([])).toBe(true);
  });

  test("recording capacity upserts and answers with the concurrency to apply", async () => {
    const db = await connected(connect);
    const record = (capacity: number, ceiling?: number, conversations?: number) =>
      db.run((q) => recordRunnerCapacitySteps(q, "box", capacity, ceiling, conversations));
    expect(await record(2)).toBeUndefined();
    expect(await record(2, 8, 1)).toBe(8);
    await seed(db, (q) =>
      q.orm
        .update(q.t.runnerCapacity)
        .set({ desired: 3 })
        .where(eq(q.t.runnerCapacity.runnerId, "box")),
    );
    expect(await record(3, 8, 1)).toBe(3);
    expect(await record(3, 3)).toBe(3);
    const stored = await db.run((q) =>
      q.one(q.orm.select().from(q.t.runnerCapacity).where(eq(q.t.runnerCapacity.runnerId, "box"))),
    );
    expect(stored).toEqual({
      runnerId: "box",
      capacity: 3,
      ceiling: 3,
      desired: 3,
      conversation: null,
    });
    await expect(record(0)).rejects.toThrow("Invalid runner capacity");
    await expect(record(4, 3)).rejects.toThrow("Invalid runner capacity ceiling");
    await expect(record(1, 3, 17)).rejects.toThrow("Invalid runner conversation capacity");
  });

  test("setting concurrency checks the runner and ceiling, then audits", async () => {
    const db = await connected(connect);
    await seedRunner(db, "box");
    const set = (concurrency: number, workspaceId = "acme") =>
      db.transaction((q) =>
        setRunnerConcurrencySteps(q, {
          runnerId: "box",
          workspaceId,
          userId: "admin",
          concurrency,
          now: NOW,
        }),
      );
    await expect(set(2, "elsewhere")).rejects.toThrow("Runner is unavailable.");
    await expect(set(2)).rejects.toBeInstanceOf(RunnerConcurrencyError);
    await seedCapacity(db, "box", { capacity: 2, ceiling: 4 });
    await expect(set(5)).rejects.toThrow("Concurrency must be from 1 to 4");
    await set(3);
    const rows = await db.run((q) =>
      q.all(
        q.orm
          .select({ desired: q.t.runnerCapacity.desired })
          .from(q.t.runnerCapacity)
          .where(eq(q.t.runnerCapacity.runnerId, "box")),
      ),
    );
    expect(rows).toEqual([{ desired: 3 }]);
    const audit = await db.run((q) =>
      q.all(
        q.orm
          .select({
            action: q.t.workspaceAccessAudit.action,
            subject: q.t.workspaceAccessAudit.subject,
          })
          .from(q.t.workspaceAccessAudit),
      ),
    );
    expect(audit).toEqual([{ action: "runner.concurrency", subject: "box" }]);
  });

  test("pinned slots are saved, replaced and released on the jobs that wait", async () => {
    const db = await connected(connect);
    await seedJob(db, 1, { itemId: "kept", pinnedSlot: { runnerId: "old", order: 1 } });
    await seedJob(
      db,
      2,
      { itemId: "dropped", pinnedSlot: { runnerId: "box", order: 2 } },
      {
        queue: "run.reverify",
      },
    );
    await seedJob(
      db,
      3,
      { itemId: "claimed", pinnedSlot: { runnerId: "box", order: 3 } },
      {
        status: "running",
      },
    );
    await seedJob(
      db,
      4,
      { itemId: "other-queue", pinnedSlot: { runnerId: "box", order: 4 } },
      {
        queue: "repo.prepare",
      },
    );
    await seedJob(db, 5, { itemId: "json-null", pinnedSlot: null });
    const save = (slots: [number, { runnerId: string; order: number }][]) =>
      db.run((q) => savePinnedSlotsSteps(q, new Map(slots)));

    await save([[1, { runnerId: "box", order: 0 }]]);
    expect(await payloadOf(db, 1)).toEqual({
      itemId: "kept",
      pinnedSlot: { runnerId: "box", order: 0 },
    });
    expect(await payloadOf(db, 2)).toEqual({ itemId: "dropped" });
    expect((await payloadOf(db, 3)).pinnedSlot).toEqual({ runnerId: "box", order: 3 });
    expect((await payloadOf(db, 4)).pinnedSlot).toEqual({ runnerId: "box", order: 4 });
    expect(await payloadOf(db, 5)).toEqual({ itemId: "json-null", pinnedSlot: null });

    await save([[3, { runnerId: "elsewhere", order: 9 }]]);
    expect((await payloadOf(db, 3)).pinnedSlot).toEqual({ runnerId: "box", order: 3 });
    expect(await payloadOf(db, 1)).toEqual({ itemId: "kept" });

    await save([[1, { runnerId: "box", order: 0 }]]);
    await save([]);
    expect(await payloadOf(db, 1)).toEqual({ itemId: "kept" });

    await db.run((q) => releasePinnedSlotSteps(q, "claimed"));
    expect(await payloadOf(db, 3)).toEqual({ itemId: "claimed" });
    await db.run((q) => releasePinnedSlotSteps(q, "other-queue"));
    expect((await payloadOf(db, 4)).pinnedSlot).toEqual({ runnerId: "box", order: 4 });
  });

  test("reserved slots rank behind the asking item's own reservation", async () => {
    const db = await connected(connect);
    const slot = (runnerId: string, order: number) => ({ pinnedSlot: { runnerId, order } });
    await seedJob(db, 1, { itemId: "first", ...slot("box", 1) });
    await seedJob(db, 2, { itemId: "second", ...slot("box", 2) }, { queue: "run.reverify" });
    await seedJob(db, 3, { itemId: "third", ...slot("box", 3) });
    await seedJob(db, 4, { itemId: "elsewhere", ...slot("other", 0) });
    await seedJob(
      db,
      5,
      { itemId: "lapsed", ...slot("box", 0) },
      { status: "running", lockedUntil: NOW },
    );
    await seedJob(
      db,
      6,
      { itemId: "claimed", ...slot("box", 0) },
      { status: "running", lockedUntil: NOW + 1 },
    );
    await seedJob(db, 7, { itemId: "no-slot", pinnedSlot: null });
    const reserved = (itemId: string) =>
      db.run((q) => pinnedSlotsReservedSteps(q, "box", itemId, NOW));
    expect(await reserved("waiting")).toBe(4);
    expect(await reserved("first")).toBe(1);
    expect(await reserved("third")).toBe(3);
  });

  test("an unresolved teardown keeps a cancel pending and names its owner", async () => {
    const db = await connected(connect);
    await seedRunner(db, "box");
    await seedRunner(db, "clear");
    await seedWork(db, "tearing-down", "box", { endedAt: 1 });
    await seedWork(db, "live", "clear");
    await seedWork(db, "confirmed", "clear", { endedAt: 1, teardownConfirmedAt: 2 });
    await seedWork(db, "reported", "clear", { endedAt: 1 });
    await seedResult(db, "reported");
    expect(await db.run((q) => runnerCancelPendingSteps(q, "box"))).toBe(true);
    expect(await db.run((q) => runnerCancelPendingSteps(q, "clear"))).toBe(false);
    expect(await db.run((q) => runTeardownOwnerSteps(q, "tearing-down"))).toBe("box");
    expect(await db.run((q) => runTeardownOwnerSteps(q, "live"))).toBeNull();
  });

  test("a foreground helper may preempt unfinished grouping", async () => {
    const db = await connected(connect);
    await seedCapacity(db, "box", { capacity: 2 });
    const availability = (foreground: boolean) =>
      db.run((q) => runnerHelperAvailabilitySteps(q, "box", NOW, foreground));
    expect(await availability(true)).toEqual({ available: true, preempts: false });

    await seedHelper(db, "grouping");
    expect(await availability(true)).toEqual({ available: true, preempts: true });
    expect(await availability(false)).toEqual({ available: false, preempts: false });

    await seedHelper(db, "other", {}, { type: "helper", purpose: "title" });
    expect(await availability(true)).toEqual({ available: false, preempts: true });
  });

  test("grouping with a stored result is not preempted", async () => {
    const db = await connected(connect);
    await seedCapacity(db, "box", { capacity: 2 });
    await seedHelper(db, "finished", { result: { ok: true } });
    const availability = () => db.run((q) => runnerHelperAvailabilitySteps(q, "box", NOW, true));
    expect(await availability()).toEqual({ available: false, preempts: false });
    await seedHelper(db, "grouping");
    expect(await availability()).toEqual({ available: false, preempts: true });
  });

  test("yielding fences only unfinished grouping helpers and closes their usage", async () => {
    const db = await connected(connect);
    await seedHelper(db, "grouping");
    await seedHelper(db, "finished", { result: { ok: true } });
    await seedHelper(db, "other", {}, { type: "helper", purpose: "title" });
    for (const commandId of ["grouping", "finished", "other"])
      await seed(db, (q) =>
        q.orm.insert(q.t.runnerExecutionUsage).values({
          commandId,
          runnerId: "box",
          ownerUserId: "owner",
          role: "implementer",
          purpose: "helper",
          startedAt: 0,
        }),
      );

    await db.transaction((q) => yieldFindingGroupHelpersSteps(q, "box", NOW));

    const helpers = await db.run((q) =>
      q.all(
        q.orm
          .select({ id: q.t.runnerHelper.id, endedAt: q.t.runnerHelper.endedAt })
          .from(q.t.runnerHelper)
          .orderBy(q.t.runnerHelper.id),
      ),
    );
    expect(helpers).toEqual([
      { id: "finished", endedAt: null },
      { id: "grouping", endedAt: NOW },
      { id: "other", endedAt: null },
    ]);
    const usage = await db.run((q) =>
      q.all(
        q.orm
          .select({
            commandId: q.t.runnerExecutionUsage.commandId,
            endedAt: q.t.runnerExecutionUsage.endedAt,
            outcome: q.t.runnerExecutionUsage.outcome,
          })
          .from(q.t.runnerExecutionUsage)
          .orderBy(q.t.runnerExecutionUsage.commandId),
      ),
    );
    expect(usage).toEqual([
      { commandId: "finished", endedAt: null, outcome: null },
      { commandId: "grouping", endedAt: NOW, outcome: "preempted" },
      { commandId: "other", endedAt: null, outcome: null },
    ]);
  });

  test("the conversation lane needs a limit, a new runner and a free seat", async () => {
    const db = await connected(connect);
    const lane = () => db.run((q) => runnerConversationLaneSteps(q, "box", NOW));
    const report = (runnerVersion: string) =>
      seed(db, (q) =>
        q.orm
          .insert(q.t.runnerHostStatus)
          .values({ runnerId: "box", runnerVersion, reportedAt: NOW }),
      );
    expect(await lane()).toBe("closed");
    await seedCapacity(db, "box", { conversation: 1 });
    expect(await lane()).toBe("closed");
    await report("0.1.74");
    expect(await lane()).toBe("free");
    expect(await db.run((q) => runnerHelperAvailabilitySteps(q, "box", NOW, true, true))).toEqual({
      available: true,
      preempts: false,
    });
    await seedHelper(db, "talking", { purpose: "conversation" });
    expect(await lane()).toBe("full");
    await seed(db, (q) =>
      q.orm
        .update(q.t.runnerHostStatus)
        .set({ runnerVersion: "0.1.73" })
        .where(and(eq(q.t.runnerHostStatus.runnerId, "box"))),
    );
    expect(await lane()).toBe("closed");
  });

  test("unfinished conversation helpers read back as stored JSON text", async () => {
    const db = await connected(connect);
    await seedHelper(db, "waiting", { purpose: "conversation" });
    await seedHelper(db, "answered", { purpose: "conversation", result: { ok: true } });
    await seedHelper(db, "ended", { purpose: "conversation", endedAt: 1 });
    await seedHelper(db, "work");
    const rows = await db.run((q) => unfinishedConversationHelpersSteps(q));
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect([...byId.keys()].sort()).toEqual(["answered", "waiting"]);
    expect(byId.get("waiting")!.result).toBeNull();
    expect(JSON.parse(byId.get("answered")!.result!)).toEqual({ ok: true });
    expect(JSON.parse(byId.get("waiting")!.envelope)).toEqual(envelope(FINDING_GROUPS));
    expect(byId.get("waiting")).toMatchObject({
      sessionId: "session-waiting",
      expiresAt: NOW + 60_000,
    });
  });
});
