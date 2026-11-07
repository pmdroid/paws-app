import { afterEach, expect, test } from "bun:test";
import {
  acknowledgeRetroDispatchSteps,
  deliverableRetroDispatchesSteps,
  getRetroDispatchSteps,
  listRetroDispatchesSteps,
  markRetroDispatchFetchedSteps,
  openRetroDispatchSteps,
  recordRetroDispatchResultSteps,
  recordRetroDispatchSteps,
  recordRetroGenerationSteps,
  releaseRetroDispatchSteps,
  requestRetroDispatchCancelSteps,
  resignRetroDispatchSteps,
  retroDispatchesNotStartedSteps,
  retroGenerationSteps,
  retroSlotsHeldSteps,
  settleRetroDispatchSteps,
  unfinishedRetroDispatchesSteps,
  type Db,
} from "../src/db";
import { forEachDialect, withoutForeignKeys, type DialectDb } from "./dialects";

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

function dispatch(db: Db, commandId: string, attempt: number, runnerId = "box", now = attempt) {
  return db.run((q) =>
    recordRetroDispatchSteps(q, {
      commandId,
      retroId: "retro",
      attempt,
      workspaceId: "ws",
      runnerId,
      runnerFence: 3,
      command: { kind: "retro", attempt },
      envelope: { signed: commandId },
      issuedAt: now,
      expiresAt: now + 100,
      now,
    }),
  );
}

forEachDialect((connect) => {
  test("a dispatch is stored with its JSON parsed and nulls kept", async () => {
    const db = await connected(connect);
    expect(await dispatch(db, "c1", 1)).toEqual({
      commandId: "c1",
      retroId: "retro",
      attempt: 1,
      workspaceId: "ws",
      runnerId: "box",
      runnerFence: 3,
      command: { kind: "retro", attempt: 1 },
      envelope: { signed: "c1" },
      deliveries: 1,
      createdAt: 1,
      issuedAt: 1,
      expiresAt: 101,
      fetchedAt: null,
      acknowledgedAt: null,
      cancelRequestedAt: null,
      result: null,
      resultAt: null,
      releasedAt: null,
      releaseReason: null,
      settledAt: null,
    });
    expect(await db.run((q) => getRetroDispatchSteps(q, "missing"))).toBeNull();
  });

  test("delivery, fetch, re-signing, acknowledgement and cancel", async () => {
    const db = await connected(connect);
    await dispatch(db, "c1", 1);
    await dispatch(db, "c2", 2);
    await dispatch(db, "other", 3, "elsewhere");
    const ids = (rows: { commandId: string }[]) => rows.map((row) => row.commandId);

    expect(ids(await db.run((q) => deliverableRetroDispatchesSteps(q, "box")))).toEqual([
      "c1",
      "c2",
    ]);
    expect(await db.run((q) => retroSlotsHeldSteps(q, "box"))).toBe(2);

    const resign = { commandId: "c1", envelope: { signed: "again" }, issuedAt: 5, expiresAt: 50 };
    expect(await db.run((q) => resignRetroDispatchSteps(q, resign))).toBe(true);
    const resigned = await db.run((q) => getRetroDispatchSteps(q, "c1"));
    expect(resigned).toMatchObject({ envelope: { signed: "again" }, deliveries: 2, expiresAt: 50 });

    await db.run((q) => markRetroDispatchFetchedSteps(q, "c1", 7));
    await db.run((q) => markRetroDispatchFetchedSteps(q, "c1", 9));
    expect((await db.run((q) => getRetroDispatchSteps(q, "c1")))!.fetchedAt).toBe(7);
    expect(await db.run((q) => resignRetroDispatchSteps(q, resign))).toBe(false);

    expect(await db.run((q) => acknowledgeRetroDispatchSteps(q, "c1", 8))).toBe(true);
    expect(await db.run((q) => getRetroDispatchSteps(q, "c1"))).toMatchObject({
      acknowledgedAt: 8,
      fetchedAt: 7,
    });

    await db.run((q) => requestRetroDispatchCancelSteps(q, "c2", 10));
    await db.run((q) => requestRetroDispatchCancelSteps(q, "c2", 11));
    expect((await db.run((q) => getRetroDispatchSteps(q, "c2")))!.cancelRequestedAt).toBe(10);
    expect(await db.run((q) => acknowledgeRetroDispatchSteps(q, "c2", 12))).toBe(false);
    expect(ids(await db.run((q) => deliverableRetroDispatchesSteps(q, "box")))).toEqual([]);
  });

  test("results, releases and settling", async () => {
    const db = await connected(connect);
    await dispatch(db, "c1", 1);
    await dispatch(db, "c2", 2);
    const result = { status: "ok", report: { items: [1, 2] } };
    const record = (commandId: string, value: unknown) =>
      db.transaction((q) =>
        recordRetroDispatchResultSteps(q, { commandId, result: value, now: 20 }),
      );

    expect(await record("missing", result)).toBe("released");
    expect(await record("c1", result)).toBe("recorded");
    expect(await record("c1", { status: "ok", report: { items: [1, 2] } })).toBe("duplicate");
    expect(await record("c1", { status: "other" })).toBe("conflict");
    expect(await db.run((q) => getRetroDispatchSteps(q, "c1"))).toMatchObject({
      result,
      resultAt: 20,
      releasedAt: 20,
      releaseReason: "result",
      acknowledgedAt: 20,
    });

    const release = { commandId: "c2", reason: "not_started" as const, now: 30 };
    expect(await db.run((q) => releaseRetroDispatchSteps(q, release))).toBe(true);
    expect(await db.run((q) => releaseRetroDispatchSteps(q, release))).toBe(false);
    expect(await record("c2", result)).toBe("released");
    expect(await db.run((q) => retroDispatchesNotStartedSteps(q, "retro"))).toBe(1);
    expect(await db.run((q) => retroSlotsHeldSteps(q, "box"))).toBe(0);

    const commandIds = (rows: { commandId: string }[]) => rows.map((row) => row.commandId);
    expect(commandIds(await db.run((q) => listRetroDispatchesSteps(q, "retro")))).toEqual([
      "c1",
      "c2",
    ]);
    expect((await db.run((q) => openRetroDispatchSteps(q, "retro")))!.commandId).toBe("c2");
    expect(commandIds(await db.run((q) => unfinishedRetroDispatchesSteps(q)))).toEqual([
      "c1",
      "c2",
    ]);

    await db.run((q) => settleRetroDispatchSteps(q, "c2", 40));
    await db.run((q) => settleRetroDispatchSteps(q, "c2", 41));
    expect((await db.run((q) => getRetroDispatchSteps(q, "c2")))!.settledAt).toBe(40);
    expect((await db.run((q) => openRetroDispatchSteps(q, "retro")))!.commandId).toBe("c1");
    await db.run((q) => settleRetroDispatchSteps(q, "c1", 42));
    expect(await db.run((q) => openRetroDispatchSteps(q, "retro"))).toBeNull();
    expect(await db.run((q) => unfinishedRetroDispatchesSteps(q))).toEqual([]);
  });

  test("generation diagnostics accumulate wait and active time", async () => {
    const db = await connected(connect);
    const record = (input: Parameters<typeof recordRetroGenerationSteps>[1]) =>
      db.transaction((q) => recordRetroGenerationSteps(q, input));

    expect(await db.run((q) => retroGenerationSteps(q, "retro"))).toBeNull();
    await record({ retroId: "retro", diagnostic: "no_runner", detail: "none", now: 100 });
    await record({ retroId: "retro", diagnostic: "no_runner", detail: "still", now: 150 });
    expect(
      await record({
        retroId: "retro",
        diagnostic: "active",
        detail: "x".repeat(2100),
        now: 175,
        until: 500,
        activeMs: 40,
      }),
    ).toEqual({
      retroId: "retro",
      diagnostic: "active",
      detail: "x".repeat(2000),
      since: 175,
      until: 500,
      waitMs: 75,
      activeMs: 40,
      updatedAt: 175,
    });
    expect(
      await record({ retroId: "retro", diagnostic: "active", detail: "", now: 200, activeMs: 5 }),
    ).toMatchObject({ since: 175, until: null, waitMs: 75, activeMs: 45 });
  });
});
