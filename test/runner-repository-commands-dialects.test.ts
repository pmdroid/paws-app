import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  cancelOpenRepositoryCommandSteps,
  completeRepositoryCommandSteps,
  expireDueRepositoryCommandsSteps,
  expireRepositoryCommandSteps,
  insertRepositoryCommandSteps,
  markRepositoryCommandDeliveredSteps,
  pendingRepositoryCommandsSteps,
  repositoryCommandReachedRunnerSteps,
  repositoryCommandRowSteps,
  setRepositoryCommandGrantSteps,
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

function insert(db: Db, id: string, row: { createdAt?: number; expiresAt?: number } = {}) {
  return db.run((q) =>
    insertRepositoryCommandSteps(q, {
      id,
      runnerId: "box",
      itemId: "item",
      payload: `{"id":"${id}"}`,
      expiresAt: 100,
      createdAt: 1,
      ...row,
    }),
  );
}

const read = (db: Db, id: string) => db.run((q) => repositoryCommandRowSteps(q, id));

forEachDialect((connect) => {
  test("a stored command reads back pending, and an unknown one is null", async () => {
    const db = await connected(connect);
    await insert(db, "a");

    expect(await read(db, "a")).toEqual({
      id: "a",
      runnerId: "box",
      payload: '{"id":"a"}',
      state: "pending",
      result: null,
      grantHash: null,
      grantExpiresAt: null,
      expiresAt: 100,
    });
    expect(await read(db, "missing")).toBeNull();
  });

  test("pending commands come oldest first, within the limit, until their deadline", async () => {
    const db = await connected(connect);
    await insert(db, "b", { createdAt: 2 });
    await insert(db, "c", { createdAt: 1 });
    await insert(db, "a", { createdAt: 2 });
    await insert(db, "due", { expiresAt: 50 });

    const pending = (at: number, limit: number) =>
      db.run((q) => pendingRepositoryCommandsSteps(q, "box", at, limit));

    expect((await pending(50, 9)).map((row) => row.id)).toEqual(["c", "a", "b"]);
    expect(await pending(50, 1)).toEqual([{ id: "c", payload: '{"id":"c"}' }]);
    expect(await db.run((q) => pendingRepositoryCommandsSteps(q, "other", 0, 9))).toEqual([]);

    await db.run((q) => markRepositoryCommandDeliveredSteps(q, "c", 60));
    expect((await pending(50, 9)).map((row) => row.id)).toEqual(["a", "b"]);
    expect((await read(db, "c"))?.state).toBe("delivered");
  });

  test("a command reaches its runner once it leaves pending", async () => {
    const db = await connected(connect);
    await insert(db, "a");
    const reached = (runnerId: string) =>
      db.run((q) => repositoryCommandReachedRunnerSteps(q, "a", runnerId));

    expect(await reached("box")).toBe(false);
    await db.run((q) => markRepositoryCommandDeliveredSteps(q, "a", 2));
    expect(await reached("box")).toBe(true);
    expect(await reached("other")).toBe(false);
  });

  test("a grant is stored, and completing the command clears it", async () => {
    const db = await connected(connect);
    await insert(db, "a");
    await db.run((q) => markRepositoryCommandDeliveredSteps(q, "a", 2));
    await db.run((q) => setRepositoryCommandGrantSteps(q, "a", "hash", 70));
    expect(await read(db, "a")).toMatchObject({ grantHash: "hash", grantExpiresAt: 70 });

    await db.run((q) => completeRepositoryCommandSteps(q, "a", '{"outcome":"rebased"}', 3));
    expect(await read(db, "a")).toMatchObject({
      state: "done",
      result: '{"outcome":"rebased"}',
      grantHash: null,
    });
  });

  test("due open commands expire and report their ids", async () => {
    const db = await connected(connect);
    await insert(db, "due", { expiresAt: 10 });
    await insert(db, "later", { expiresAt: 11 });
    await insert(db, "finished", { expiresAt: 10 });
    await db.run((q) => completeRepositoryCommandSteps(q, "finished", "{}", 5));
    await db.run((q) => setRepositoryCommandGrantSteps(q, "due", "hash", 9));

    expect(await db.run((q) => expireDueRepositoryCommandsSteps(q, 10))).toEqual(["due"]);
    expect(await read(db, "due")).toMatchObject({ state: "expired", grantHash: null });
    expect((await read(db, "later"))?.state).toBe("pending");
    expect((await read(db, "finished"))?.state).toBe("done");
    expect(await db.run((q) => expireDueRepositoryCommandsSteps(q, 10))).toEqual([]);
  });

  test("at its deadline a command expires unless it is done, and always loses its grant", async () => {
    const db = await connected(connect);
    await insert(db, "open");
    await insert(db, "finished");
    await db.run((q) => markRepositoryCommandDeliveredSteps(q, "finished", 2));
    await db.run((q) => setRepositoryCommandGrantSteps(q, "finished", "hash", 9));
    await db.run((q) =>
      q.exec(
        q.orm
          .update(q.t.runnerRepositoryCommand)
          .set({ state: "done", result: "{}" })
          .where(eq(q.t.runnerRepositoryCommand.id, "finished")),
      ),
    );

    const expire = (id: string) => db.run((q) => expireRepositoryCommandSteps(q, id));
    expect(await expire("open")).toBe("expired");
    expect(await expire("finished")).toBe("done");
    expect((await read(db, "finished"))?.grantHash).toBeNull();
    expect(await expire("missing")).toBeNull();
  });

  test("only an open command can be cancelled", async () => {
    const db = await connected(connect);
    await insert(db, "a");
    const cancel = () => db.run((q) => cancelOpenRepositoryCommandSteps(q, "a"));

    expect(await cancel()).toBe(true);
    expect((await read(db, "a"))?.state).toBe("expired");
    expect(await cancel()).toBe(false);
  });
});
