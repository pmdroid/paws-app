import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  collectingRetroIdsSteps,
  createRetroSteps,
  latestPublishedRetroSteps,
  latestRetroDispatchSteps,
  latestRetroSteps,
  listRetroSettingsRevisionsSteps,
  previousRetroResultDispatchSteps,
  recordRetroDispatchResultSteps,
  recordRetroDispatchSteps,
  recordRetroGenerationSteps,
  recordRetroOccurrenceSteps,
  releaseRetroDispatchSteps,
  retroDispatchReleaseReasonSteps,
  retroHasUnfinishedDispatchSteps,
  retroIdForWindowSteps,
  retroOccurrenceSteps,
  retroSettingsWorkspacesSteps,
  retrosToAdvanceSteps,
  runnerIdentitySteps,
  saveRetroSettingsRevisionSteps,
  settleRetroDispatchSteps,
  workItemSessionKeysSteps,
  type Db,
  type RetroState,
} from "../src/db";
import {
  forEachDialect,
  insertWorkItem,
  jsonValue,
  seed,
  withoutForeignKeys,
  type DialectDb,
} from "./dialects";

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

function settings(db: Db, workspaceId: string, now: number) {
  return db.transaction((q) =>
    saveRetroSettingsRevisionSteps(q, {
      workspaceId,
      prompt: "Review {{digest}}",
      agentProfile: { agent: "codex" },
      repositories: ["pmdroid/paws-app"],
      outputLimits: {},
      executionLimits: {},
      schedule: { cadence: "weekly", time: `0${now}:00` },
      createdBy: "pascal",
      now,
    }),
  );
}

async function retro(db: Db, id: string, createdAt: number, state: RetroState, windowEnd = 10) {
  await db.transaction((q) =>
    createRetroSteps(q, {
      id,
      workspaceId: "ws",
      windowStart: createdAt,
      windowEnd,
      origin: "manual",
      settingsRevision: 1,
      now: createdAt,
    }),
  );
  const hash = "0".repeat(64);
  await db.run((q) =>
    q.exec(
      q.orm
        .update(q.t.retro)
        .set({
          state,
          digestSha256: hash,
          manifestSha256: hash,
          ...(state === "published" ? { result: jsonValue(q, {}), resultSha256: hash } : {}),
        })
        .where(eq(q.t.retro.id, id)),
    ),
  );
}

function dispatch(db: Db, commandId: string, retroId: string, attempt: number) {
  return db.run((q) =>
    recordRetroDispatchSteps(q, {
      commandId,
      retroId,
      attempt,
      workspaceId: "ws",
      runnerId: "box",
      runnerFence: 1,
      command: { attempt },
      envelope: {},
      issuedAt: attempt,
      expiresAt: attempt + 100,
      now: attempt,
    }),
  );
}

forEachDialect((connect) => {
  test("settings revisions list newest first, and workspaces list once each", async () => {
    const db = await connected(connect);
    await settings(db, "ws", 1);
    await settings(db, "ws", 2);
    await settings(db, "other", 3);
    const revisions = await db.run((q) => listRetroSettingsRevisionsSteps(q, "ws"));
    expect(revisions.map((row) => [row.revision, row.schedule])).toEqual([
      [2, { cadence: "weekly", time: "02:00" }],
      [1, { cadence: "weekly", time: "01:00" }],
    ]);
    expect(await db.run((q) => listRetroSettingsRevisionsSteps(q, "none"))).toEqual([]);
    expect(await db.run((q) => retroSettingsWorkspacesSteps(q))).toEqual(["other", "ws"]);
  });

  test("retros are found by window, latest creation, state and publication", async () => {
    const db = await connected(connect);
    await settings(db, "ws", 1);
    await retro(db, "a", 1, "published", 30);
    await retro(db, "b", 2, "published", 20);
    await retro(db, "c", 3, "collecting");
    await retro(db, "d", 4, "collecting");
    await retro(db, "e", 5, "abandoned");
    expect(await db.run((q) => retroIdForWindowSteps(q, "ws", 3, 10))).toBe("c");
    expect(await db.run((q) => retroIdForWindowSteps(q, "ws", 3, 11))).toBeNull();
    expect((await db.run((q) => latestRetroSteps(q, "ws")))?.id).toBe("e");
    expect((await db.run((q) => latestRetroSteps(q, "ws", ["collecting", "queued"])))?.id).toBe(
      "d",
    );
    expect(await db.run((q) => latestRetroSteps(q, "ws", ["failed"]))).toBeNull();
    expect((await db.run((q) => latestPublishedRetroSteps(q, "ws")))?.id).toBe("a");
    expect(await db.run((q) => latestPublishedRetroSteps(q, "none"))).toBeNull();
    expect(await db.run((q) => collectingRetroIdsSteps(q, "ws"))).toEqual(["c", "d"]);
  });

  test("an occurrence is recorded once and read back", async () => {
    const db = await connected(connect);
    const occurrence = {
      retroId: "r1",
      workspaceId: "ws",
      origin: "scheduled",
      occurrenceAt: 100,
      windowStart: 0,
      windowEnd: 100,
      timeZone: "Europe/Berlin",
      localDate: "2026-11-09",
      localTime: "09:00",
      utcOffsetMinutes: 60,
      localAdjustment: "exact",
      settingsRevision: 1,
      requestedBy: null,
      createdAt: 5,
    };
    expect(await db.run((q) => retroOccurrenceSteps(q, "r1"))).toBeNull();
    await db.run((q) => recordRetroOccurrenceSteps(q, occurrence));
    await db.run((q) => recordRetroOccurrenceSteps(q, { ...occurrence, localTime: "10:00" }));
    expect(await db.run((q) => retroOccurrenceSteps(q, "r1"))).toEqual({
      origin: "scheduled",
      occurrenceAt: 100,
      timeZone: "Europe/Berlin",
      localDate: "2026-11-09",
      localTime: "09:00",
      utcOffsetMinutes: 60,
      adjustment: "exact",
      requestedBy: null,
    });
  });

  test("dispatch reads: release reason, latest, previous result and unfinished", async () => {
    const db = await connected(connect);
    await dispatch(db, "c1", "r1", 1);
    await db.transaction((q) =>
      recordRetroDispatchResultSteps(q, { commandId: "c1", result: { outcome: "x" }, now: 5 }),
    );
    await dispatch(db, "c2", "r1", 2);
    await db.run((q) =>
      releaseRetroDispatchSteps(q, { commandId: "c2", reason: "not_started", now: 6 }),
    );
    await dispatch(db, "c3", "r1", 3);
    expect(await db.run((q) => retroDispatchReleaseReasonSteps(q, "r1", 1))).toBe("result");
    expect(await db.run((q) => retroDispatchReleaseReasonSteps(q, "r1", 2))).toBe("not_started");
    expect(await db.run((q) => retroDispatchReleaseReasonSteps(q, "r1", 3))).toBeNull();
    expect(await db.run((q) => retroDispatchReleaseReasonSteps(q, "r1", 4))).toBeNull();
    expect((await db.run((q) => latestRetroDispatchSteps(q, "r1")))?.commandId).toBe("c3");
    expect(await db.run((q) => latestRetroDispatchSteps(q, "none"))).toBeNull();
    const previous = await db.run((q) => previousRetroResultDispatchSteps(q, "r1", 3));
    expect([previous?.commandId, previous?.result]).toEqual(["c1", { outcome: "x" }]);
    expect(await db.run((q) => previousRetroResultDispatchSteps(q, "r1", 1))).toBeNull();
    expect(await db.run((q) => retroHasUnfinishedDispatchSteps(q, "r1"))).toBe(true);
    await db.run((q) =>
      releaseRetroDispatchSteps(q, { commandId: "c3", reason: "teardown", now: 7 }),
    );
    for (const id of ["c1", "c2", "c3"]) await db.run((q) => settleRetroDispatchSteps(q, id, 8));
    expect(await db.run((q) => retroHasUnfinishedDispatchSteps(q, "r1"))).toBe(false);
  });

  test("the dispatcher advances retros to generate and those with unsettled dispatches", async () => {
    const db = await connected(connect);
    await settings(db, "ws", 1);
    await retro(db, "queued", 1, "queued");
    await retro(db, "failed-for-good", 2, "failed");
    await retro(db, "published", 3, "published");
    await retro(db, "unsettled", 4, "published");
    await retro(db, "generating", 5, "generating");
    await db.transaction((q) =>
      recordRetroGenerationSteps(q, {
        retroId: "failed-for-good",
        diagnostic: "failed",
        detail: "gave up",
        now: 6,
      }),
    );
    await dispatch(db, "c1", "unsettled", 1);
    expect(await db.run((q) => retrosToAdvanceSteps(q))).toEqual([
      "queued",
      "unsettled",
      "generating",
    ]);
  });

  test("a runner's identity and work items' session keys", async () => {
    const db = await connected(connect);
    await seed(db, (q) =>
      q.orm.insert(q.t.runner).values({
        id: "box",
        workspaceId: "ws",
        ownerUserId: "owner",
        name: "box",
        status: "active",
        fence: 4,
        createdAt: 0,
        lastSeenAt: 9,
      }),
    );
    expect(await db.run((q) => runnerIdentitySteps(q, "box"))).toEqual({
      workspaceId: "ws",
      ownerId: "owner",
      status: "active",
      fence: 4,
      revokedAt: null,
      lastSeenAt: 9,
    });
    expect(await db.run((q) => runnerIdentitySteps(q, "none"))).toBeNull();
    await insertWorkItem(db, "i1");
    await insertWorkItem(db, "i2");
    await db.run((q) =>
      q.exec(q.orm.update(q.t.workItem).set({ sessionKey: "s1" }).where(eq(q.t.workItem.id, "i1"))),
    );
    const keys = await db.run((q) => workItemSessionKeysSteps(q, ["i1", "i2", "missing"]));
    expect(keys.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: "i1", sessionKey: "s1" },
      { id: "i2", sessionKey: null },
    ]);
    expect(await db.run((q) => workItemSessionKeysSteps(q, []))).toEqual([]);
  });
});
