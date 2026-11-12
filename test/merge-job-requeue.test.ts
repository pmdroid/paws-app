import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cancelOpenJobs, getJob } from "../src/db";
import { enqueueVerifiedMerge } from "../src/loop";
import { seed } from "./dialects";
import { tempStore } from "./pglite";

test.each(["done", "cancelled", "dead"] as const)(
  "a retried item revives a %s merge job for the same head",
  async (status) => {
    const { db, close } = await tempStore();
    try {
      const input = { itemId: "item", head: "a".repeat(40), summary: "accepted", now: 1_000 };
      const first = await enqueueVerifiedMerge(db, input);
      await cancelOpenJobs(db, { itemId: "item", reason: "merge", now: 2_000 });
      await seed(db, (q) =>
        q.orm.update(q.t.job).set({ status, attempts: 5 }).where(eq(q.t.job.id, first)),
      );
      const again = await enqueueVerifiedMerge(db, {
        ...input,
        summary: "accepted again",
        now: 3_000,
      });
      expect(again).toBe(first);
      expect(await getJob(db, again)).toMatchObject({
        status: "pending",
        attempts: 0,
        runAt: 3_000,
      });
      expect((await getJob(db, again))?.payload).toMatchObject({
        summary: "accepted again",
      });
    } finally {
      await close();
    }
  },
);
