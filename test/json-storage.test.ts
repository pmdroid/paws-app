import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { enqueueJob, getJob, type Db } from "../src/db";
import { jsonFromText } from "../src/db/json-text";
import { forEachDialect, type DialectDb } from "./dialects";

function jsonType(db: Db, id: number): Promise<string> {
  return db.run(function* (q) {
    const type = q.dialect === "sqlite" ? sql`json_type` : sql`jsonb_typeof`;
    const rows = yield* q.all(
      q.orm
        .select({ type: sql<string>`${type}(${q.t.job.payload})` })
        .from(q.t.job)
        .where(eq(q.t.job.id, id)),
    );
    return rows[0]!.type;
  });
}

forEachDialect((open) => {
  let handle: DialectDb;
  beforeEach(async () => {
    handle = await open();
  });
  afterEach(() => handle.close());

  test("a jsonb column stores an object as an object", async () => {
    const id = await enqueueJob(handle.db, { queue: "q", payload: { a: 1 }, now: 0 });
    expect(await jsonType(handle.db, id)).toBe("object");
    expect((await getJob(handle.db, id))?.payload).toEqual({ a: 1 });
  });

  test("JSON text bound into a raw fragment is stored as an object", async () => {
    const id = await enqueueJob(handle.db, { queue: "q", payload: {}, now: 0 });
    await handle.db.run(function* (q) {
      yield* q.exec(
        q.orm
          .update(q.t.job)
          .set({ payload: jsonFromText(q, JSON.stringify({ b: [2] })) })
          .where(eq(q.t.job.id, id)),
      );
    });
    expect(await jsonType(handle.db, id)).toBe("object");
    expect((await getJob(handle.db, id))?.payload).toEqual({ b: [2] });
  });
});
