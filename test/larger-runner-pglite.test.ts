import { afterEach, expect, test } from "bun:test";
import {
  largerRunnerIdsSteps,
  recordRunnerHostStatusSteps,
  workspaceRunnerIdsSteps,
  type Db,
} from "../src/db";
import { describePglite, withoutForeignKeys, type PgliteTestDb } from "./pglite-fixtures";

const GB = 1024 ** 3;
const opened: PgliteTestDb[] = [];
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close();
});

async function connect(open: () => Promise<PgliteTestDb>): Promise<Db> {
  const handle = await open();
  opened.push(handle);
  await withoutForeignKeys(handle.db);
  return handle.db;
}

function addRunner(db: Db, id: string, workspaceId: string, memoryGb: number | null) {
  return db.run(function* (q) {
    yield* q.exec(
      q.orm.insert(q.t.runner).values({
        id,
        workspaceId,
        ownerUserId: "owner",
        name: id,
        status: "active",
        createdAt: 0,
        lastSeenAt: 0,
      }),
    );
    if (memoryGb !== null)
      yield* recordRunnerHostStatusSteps(q, id, { memoryTotalBytes: memoryGb * GB }, 0);
  });
}

describePglite((open) => {
  test("only runners in the same workspace with more memory count as larger", async () => {
    const db = await connect(open);
    await addRunner(db, "small", "acme", 4);
    await addRunner(db, "same", "acme", 4);
    await addRunner(db, "large", "acme", 16);
    await addRunner(db, "unknown", "acme", null);
    await addRunner(db, "elsewhere", "other", 32);
    expect(await db.run((q) => largerRunnerIdsSteps(q, "small"))).toEqual(["large"]);
    expect(await db.run((q) => largerRunnerIdsSteps(q, "large"))).toEqual([]);
    expect(await db.run((q) => largerRunnerIdsSteps(q, "unknown"))).toBeNull();
    expect((await db.run((q) => workspaceRunnerIdsSteps(q, "small"))).sort()).toEqual([
      "large",
      "same",
      "small",
      "unknown",
    ]);
  });
});
