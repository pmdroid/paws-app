import { afterEach, expect, test } from "bun:test";
import {
  countRebaseReturnsSteps,
  listRebaseReturnsSteps,
  rebaseReturnedForSteps,
  recordRebaseReturnSteps,
} from "../src/db";
import { forEachDialect, insertWorkItem, type DialectDb } from "./dialects";

const open: DialectDb[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

forEachDialect((connect) => {
  test("a rebase return counts once per job activation, from the activation asked for", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await insertWorkItem(db, "ENG-1");
    const jobId = await db.run(function* (q) {
      const [row] = yield* q.all(
        q.orm
          .insert(q.t.job)
          .values({ queue: "merge", runAt: 0, createdAt: 0 })
          .returning({ id: q.t.job.id }),
      );
      return row!.id;
    });

    const record = (returnedBy: number, candidate: string, files?: string[] | null) =>
      db.run((q) =>
        recordRebaseReturnSteps(q, {
          itemId: "ENG-1",
          jobId: returnedBy,
          candidate,
          reason: "merge",
          base: files === undefined ? undefined : "main1",
          files,
          recordedAt: files === undefined ? undefined : 500,
        }),
      );
    await record(jobId, "head-a", ["b.ts", "a.ts"]);
    await record(jobId, "head-b", null);
    await record(1_000, "head-c");

    // A job's return records the job's activation; a return without a job row uses the job id.
    const activations = await db.run(function* (q) {
      const { job, rebaseReturn } = q.t;
      const [started] = yield* q.all(q.orm.select({ id: job.activationId }).from(job));
      const stored = yield* q.all(
        q.orm
          .select({ id: rebaseReturn.activationId })
          .from(rebaseReturn)
          .orderBy(rebaseReturn.activationId),
      );
      return { job: started!.id, stored: stored.map((row) => row.id) };
    });
    expect(activations.stored).toEqual([activations.job, 1_000]);
    expect(await db.run((q) => countRebaseReturnsSteps(q, "ENG-1", 0))).toBe(2);
    expect(await db.run((q) => countRebaseReturnsSteps(q, "ENG-1", 1_000))).toBe(1);
    expect(await db.run((q) => countRebaseReturnsSteps(q, "ENG-2", 0))).toBe(0);
    expect(await db.run((q) => listRebaseReturnsSteps(q, "ENG-1", 0))).toEqual([
      { jobId, reason: "merge", base: "main1", files: ["b.ts", "a.ts"], recordedAt: 500 },
      { jobId: 1_000, reason: "merge", base: null, files: null, recordedAt: null },
    ]);
    expect(await db.run((q) => rebaseReturnedForSteps(q, "ENG-1", "head-a"))).toBe(true);
    expect(await db.run((q) => rebaseReturnedForSteps(q, "ENG-1", "head-b"))).toBe(false);
  });
});
