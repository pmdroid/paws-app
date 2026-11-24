import { afterEach, expect, test } from "bun:test";
import { largerOnlineRunnerSteps, recordRunnerHostStatusSteps, type Db } from "../src/db";
import { describePglite, seed, withoutForeignKeys, type PgliteTestDb } from "./pglite-fixtures";

const GB = 1024 ** 3;
const opened: PgliteTestDb[] = [];
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close();
});

async function connect(open: () => Promise<PgliteTestDb>): Promise<Db> {
  const handle = await open();
  opened.push(handle);
  await withoutForeignKeys(handle.db);
  await seed(handle.db, (q) =>
    q.orm.insert(q.t.workspaceMember).values({
      workspaceId: "acme",
      userId: "owner",
      role: "member",
      source: "linear",
      active: 1,
      checkedAt: 0,
    }),
  );
  return handle.db;
}

function addRunner(db: Db, id: string, memoryGb: number, lastSeenAt: number) {
  return db.run(function* (q) {
    yield* q.exec(
      q.orm.insert(q.t.runner).values({
        id,
        workspaceId: "acme",
        ownerUserId: "owner",
        name: id,
        status: "active",
        createdAt: 0,
        lastSeenAt,
      }),
    );
    yield* recordRunnerHostStatusSteps(q, id, { memoryTotalBytes: memoryGb * GB }, 0);
  });
}

describePglite((open) => {
  test("another runner with more memory is offered only while it is online", async () => {
    const db = await connect(open);
    await addRunner(db, "small", 4, 1_000);
    await addRunner(db, "same", 4, 1_000);
    expect(await db.run((q) => largerOnlineRunnerSteps(q, "small", 500))).toBe(false);
    await addRunner(db, "large", 16, 400);
    expect(await db.run((q) => largerOnlineRunnerSteps(q, "small", 500))).toBe(false);
    expect(await db.run((q) => largerOnlineRunnerSteps(q, "small", 300))).toBe(true);
    expect(await db.run((q) => largerOnlineRunnerSteps(q, "large", 300))).toBe(false);
  });
});
