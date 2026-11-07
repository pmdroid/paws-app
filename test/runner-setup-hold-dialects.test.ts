import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { JOB_KIND } from "../src/core";
import {
  enqueueRunnerSetupCheckSteps,
  getRunnerSetupHoldSteps,
  holdForRunnerSetupSteps,
  listRunnerSetupHoldsSteps,
  markRunnerSetupNotifiedSteps,
  releaseRunnerSetupHoldSteps,
  takeRunnerSetupResumeSteps,
} from "../src/db";
import { forEachDialect, insertWorkItem, withoutForeignKeys } from "./dialects";

forEachDialect((open) => {
  test("a hold keeps its start, takes the latest reason and lists oldest first", async () => {
    const { db, close } = await open();
    try {
      await withoutForeignKeys(db);
      await insertWorkItem(db, "first");
      await insertWorkItem(db, "second");
      await db.run((q) =>
        holdForRunnerSetupSteps(q, {
          itemId: "second",
          ownerUserId: "u",
          reason: "no-runner",
          runId: "run",
          now: 5,
        }),
      );
      await db.run((q) => markRunnerSetupNotifiedSteps(q, "second", 6));
      await db.run((q) => markRunnerSetupNotifiedSteps(q, "second", 7));
      const held = await db.run((q) =>
        holdForRunnerSetupSteps(q, {
          itemId: "second",
          ownerUserId: "u",
          reason: "agent-not-signed-in",
          runnerId: "box",
          agent: "codex",
          now: 8,
        }),
      );
      expect(held).toEqual({
        itemId: "second",
        ownerUserId: "u",
        reason: "agent-not-signed-in",
        runnerId: "box",
        agent: "codex",
        runId: "run",
        since: 5,
        notifiedAt: 6,
      });
      await db.run((q) =>
        holdForRunnerSetupSteps(q, {
          itemId: "first",
          ownerUserId: "v",
          reason: "no-runner",
          now: 9,
        }),
      );
      expect(await db.run((q) => getRunnerSetupHoldSteps(q, "second"))).toEqual(held);
      expect(await db.run((q) => getRunnerSetupHoldSteps(q, "none"))).toBeNull();
      expect(
        (await db.run((q) => listRunnerSetupHoldsSteps(q))).map((hold) => hold.itemId),
      ).toEqual(["second", "first"]);
      expect(
        (await db.run((q) => listRunnerSetupHoldsSteps(q, "v"))).map((hold) => hold.itemId),
      ).toEqual(["first"]);
    } finally {
      await close();
    }
  });

  test("releasing a hold resumes its run once", async () => {
    const { db, close } = await open();
    try {
      await withoutForeignKeys(db);
      await insertWorkItem(db, "item");
      await db.run((q) =>
        holdForRunnerSetupSteps(q, {
          itemId: "item",
          ownerUserId: null,
          reason: "no-runner",
          runId: "run",
          now: 1,
        }),
      );
      expect(await db.run((q) => releaseRunnerSetupHoldSteps(q, "item", 2))).toBe(true);
      expect(await db.run((q) => releaseRunnerSetupHoldSteps(q, "item", 3))).toBe(false);
      expect(await db.run((q) => getRunnerSetupHoldSteps(q, "item"))).toBeNull();
      expect(await db.run((q) => takeRunnerSetupResumeSteps(q, "item", "other"))).toBe(false);
      expect(await db.run((q) => takeRunnerSetupResumeSteps(q, "item", "run"))).toBe(false);

      await db.run((q) =>
        holdForRunnerSetupSteps(q, {
          itemId: "item",
          ownerUserId: null,
          reason: "no-runner",
          runId: "run",
          now: 4,
        }),
      );
      expect(await db.run((q) => releaseRunnerSetupHoldSteps(q, "item", 5))).toBe(true);
      expect(await db.run((q) => takeRunnerSetupResumeSteps(q, "item", "run"))).toBe(true);
    } finally {
      await close();
    }
  });

  test("one setup check is pending per owner", async () => {
    const { db, close } = await open();
    try {
      expect(await db.run((q) => enqueueRunnerSetupCheckSteps(q, "u", 1))).toBe(true);
      expect(await db.run((q) => enqueueRunnerSetupCheckSteps(q, "u", 2))).toBe(false);
      expect(await db.run((q) => enqueueRunnerSetupCheckSteps(q, "v", 3))).toBe(true);
      const jobs = await db.run((q) =>
        q.all(
          q.orm
            .select({ runAt: q.t.job.runAt, maxAttempts: q.t.job.maxAttempts })
            .from(q.t.job)
            .where(eq(q.t.job.queue, JOB_KIND.runnerSetupCheck))
            .orderBy(q.t.job.runAt),
        ),
      );
      expect(jobs).toEqual([
        { runAt: 1, maxAttempts: 3 },
        { runAt: 3, maxAttempts: 3 },
      ]);
    } finally {
      await close();
    }
  });
});
