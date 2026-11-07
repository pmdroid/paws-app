import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { JOB_KIND, type LinearCommand } from "../src/core";
import { enqueueCommandSteps } from "../src/db";
import { forEachDialect } from "./dialects";

forEachDialect((open) => {
  test("a command is enqueued once per type, item and request time", async () => {
    const { db, close } = await open();
    try {
      const command: LinearCommand = {
        type: "stop",
        itemId: "item",
        source: "linear",
        requestedAt: 10,
      };
      const first = await db.run((q) => enqueueCommandSteps(q, command));
      expect(first.inserted).toBe(true);
      expect(await db.run((q) => enqueueCommandSteps(q, command, 20))).toEqual({
        id: first.id,
        inserted: false,
      });
      const later = await db.run((q) => enqueueCommandSteps(q, { ...command, requestedAt: 11 }));
      expect(later.inserted).toBe(true);
      const jobs = await db.run((q) =>
        q.all(
          q.orm
            .select({ jobKey: q.t.job.jobKey, priority: q.t.job.priority, runAt: q.t.job.runAt })
            .from(q.t.job)
            .where(eq(q.t.job.queue, JOB_KIND.command))
            .orderBy(q.t.job.runAt),
        ),
      );
      expect(jobs).toEqual([
        { jobKey: "cmd:stop:item:10", priority: 0, runAt: 10 },
        { jobKey: "cmd:stop:item:11", priority: 0, runAt: 11 },
      ]);
    } finally {
      await close();
    }
  });
});
