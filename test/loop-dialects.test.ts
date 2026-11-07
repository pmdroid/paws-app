import { afterEach, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import {
  cancelUnhandledJobSteps,
  getJobSteps,
  removeUnknownRecurringJobsSteps,
  type Job,
} from "../src/db";
import { forEachDialect, seed, type DialectDb } from "./dialects";

const open: DialectDb[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

forEachDialect((connect) => {
  test("recurring jobs without a registered handler are removed", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await seed(db, (q) =>
      q.orm.insert(q.t.job).values([
        { id: 1, queue: "known", runAt: 0, createdAt: 0, recurringEveryMs: 1_000 },
        { id: 2, queue: "unknown", runAt: 0, createdAt: 0, recurringEveryMs: 1_000 },
        { id: 3, queue: "unknown", runAt: 0, createdAt: 0 },
      ]),
    );
    expect(await db.run((q) => removeUnknownRecurringJobsSteps(q, ["known"]))).toEqual([
      { id: 2, queue: "unknown" },
    ]);
    const left = await db.run((q) =>
      q.all(q.orm.select({ id: q.t.job.id }).from(q.t.job).orderBy(asc(q.t.job.id))),
    );
    expect(left).toEqual([{ id: 1 }, { id: 3 }]);
    expect(await db.run((q) => removeUnknownRecurringJobsSteps(q, []))).toEqual([
      { id: 1, queue: "known" },
    ]);
  });

  test("a claimed job without a handler is cancelled only under its own claim", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await seed(db, (q) =>
      q.orm
        .insert(q.t.job)
        .values({
          id: 1,
          queue: "gone",
          runAt: 0,
          createdAt: 0,
          status: "running",
          lockedBy: "w1",
          lockedUntil: 50,
        }),
    );
    const claimed = (await db.run((q) => getJobSteps(q, 1)))!;
    const other: Job = { ...claimed, lockedBy: "w2" };
    expect(await db.run((q) => cancelUnhandledJobSteps(q, other, "No handler for gone", 10))).toBe(
      false,
    );
    expect(
      await db.run((q) => cancelUnhandledJobSteps(q, claimed, "No handler for gone", 10)),
    ).toBe(true);
    const row = await db.run((q) =>
      q.one(
        q.orm
          .select({
            status: q.t.job.status,
            lastError: q.t.job.lastError,
            finishedAt: q.t.job.finishedAt,
            lockedBy: q.t.job.lockedBy,
            lockedUntil: q.t.job.lockedUntil,
          })
          .from(q.t.job)
          .where(eq(q.t.job.id, 1)),
      ),
    );
    expect(row).toEqual({
      status: "cancelled",
      lastError: "No handler for gone",
      finishedAt: 10,
      lockedBy: null,
      lockedUntil: null,
    });
    expect(
      await db.run((q) => cancelUnhandledJobSteps(q, claimed, "No handler for gone", 11)),
    ).toBe(false);
  });
});
