import { afterEach, expect, test } from "bun:test";
import {
  acknowledgeRunnerHelperSteps,
  endRunnerHelperSteps,
  insertRunnerHelperSteps,
  runnerHelperResultMatchesSteps,
  runnerHelperRowSteps,
  storeRunnerHelperResultSteps,
  unacknowledgedRunnerHelpersSteps,
  usableRunnerSteps,
  type Db,
} from "../src/db";
import { forEachDialect, seed, withoutForeignKeys, type DialectDb } from "./dialects";
import { seedRunner } from "./runner-rows";

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

function insert(db: Db, id: string, row: { runnerId?: string; expiresAt?: number } = {}) {
  return db.run((q) =>
    insertRunnerHelperSteps(q, {
      id,
      runnerId: "box",
      workspaceId: "acme",
      sessionId: "session",
      sessionGeneration: 1,
      runnerFence: 3,
      envelope: JSON.stringify({ payload: id, signature: "s" }),
      expiresAt: 100,
      purpose: "conversation",
      ...row,
    }),
  );
}

const read = (db: Db, id: string) => db.run((q) => runnerHelperRowSteps(q, id));

function seedMember(db: Db, row: { active?: number; revokedAt?: number } = {}) {
  return seed(db, (q) =>
    q.orm.insert(q.t.workspaceMember).values({
      workspaceId: "acme",
      userId: "owner",
      role: "admin",
      source: "manual",
      active: 1,
      checkedAt: 0,
      ...row,
    }),
  );
}

forEachDialect((connect) => {
  test("a helper reads back with its envelope as JSON text and no result", async () => {
    const db = await connected(connect);
    await insert(db, "a");

    const row = await read(db, "a");
    expect(row).toMatchObject({
      runnerId: "box",
      workspaceId: "acme",
      runnerFence: 3,
      endedAt: null,
      result: null,
    });
    expect(JSON.parse(row!.envelope)).toEqual({ payload: "a", signature: "s" });
    expect(await read(db, "missing")).toBeNull();
  });

  test("unacknowledged helpers exclude acknowledged, ended, expired and other runners'", async () => {
    const db = await connected(connect);
    await insert(db, "z");
    await insert(db, "a");
    await insert(db, "acked");
    await insert(db, "ended");
    await insert(db, "expired", { expiresAt: 50 });
    await insert(db, "elsewhere", { runnerId: "other" });
    await db.run((q) => acknowledgeRunnerHelperSteps(q, "acked", 1));
    await db.run((q) => endRunnerHelperSteps(q, "ended", 1));

    expect(await db.run((q) => unacknowledgedRunnerHelpersSteps(q, "box", 50))).toEqual(
      db.dialect === "sqlite" ? ["z", "a"] : ["a", "z"],
    );
  });

  test("acknowledging and ending keep the first time", async () => {
    const db = await connected(connect);
    await insert(db, "a");
    await db.run((q) => acknowledgeRunnerHelperSteps(q, "a", 5));
    await db.run((q) => acknowledgeRunnerHelperSteps(q, "a", 6));
    await db.run((q) => endRunnerHelperSteps(q, "a", 7));
    await db.run((q) => endRunnerHelperSteps(q, "a", 8));

    expect((await read(db, "a"))?.endedAt).toBe(7);
    const [row] = await db.run((q) =>
      q.all(q.orm.select({ at: q.t.runnerHelper.acknowledgedAt }).from(q.t.runnerHelper)),
    );
    expect(row?.at).toBe(5);
  });

  test("a stored result reads back and matches only the same payload", async () => {
    const db = await connected(connect);
    const payload = JSON.stringify({ commandId: "a", ok: true });
    await insert(db, "a");
    const matches = (candidate: string) =>
      db.run((q) => runnerHelperResultMatchesSteps(q, "a", candidate));

    expect(await matches(payload)).toBe(false);
    await db.run((q) => storeRunnerHelperResultSteps(q, "a", payload));
    expect(JSON.parse((await read(db, "a"))!.result!)).toEqual(JSON.parse(payload));
    expect(await matches(payload)).toBe(true);
    expect(await matches('{"commandId":"a","ok":false}')).toBe(false);
  });

  test("a runner is usable while it is unrevoked and its owner is an active member", async () => {
    const db = await connected(connect);
    await seedRunner(db, "box", { status: "paused" });
    await seedRunner(db, "revoked", { revokedAt: 1 });
    await seedRunner(db, "status-revoked", { status: "revoked" });
    const usable = (id: string) => db.run((q) => usableRunnerSteps(q, id));

    expect(await usable("box")).toBeNull();
    await seedMember(db);
    expect(await usable("box")).toEqual({
      workspaceId: "acme",
      userId: "owner",
      fence: 0,
      status: "paused",
    });
    expect(await usable("revoked")).toBeNull();
    expect(await usable("status-revoked")).toBeNull();
    expect(await usable("missing")).toBeNull();
  });

  test("a runner stops being usable when its owner's membership ends", async () => {
    for (const row of [{ active: 0 }, { revokedAt: 1 }]) {
      const db = await connected(connect);
      await seedRunner(db, "box");
      await seedMember(db, row);
      expect(await db.run((q) => usableRunnerSteps(q, "box"))).toBeNull();
    }
  });
});
