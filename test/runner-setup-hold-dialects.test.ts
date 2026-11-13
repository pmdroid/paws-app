import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { JOB_KIND } from "../src/core";
import {
  enqueueRunnerSetupCheckSteps,
  enqueueRunnerSetupChecks,
  getRunnerSetupHoldSteps,
  holdForRunnerSetupSteps,
  insertRun,
  listRunnerSetupHoldsSteps,
  markRunnerSetupNotifiedSteps,
  releaseRunnerSetupHoldSteps,
  setRunnerAgentSignedInSteps,
  takeRunnerSetupResumeSteps,
} from "../src/db";
import { forEachDialect, insertWorkItem, seed, withoutForeignKeys } from "./dialects";

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

  test("a Stop ends the hold and drops its resume, and leaving the queue ends the hold", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "stopped");
      await insertWorkItem(db, "started");
      const run = await insertRun(db, { itemId: "stopped", now: 1, status: "active" });
      const hold = (itemId: string, now: number) =>
        db.run((q) =>
          holdForRunnerSetupSteps(q, {
            itemId,
            ownerUserId: null,
            reason: "no-runner",
            runId: itemId === "stopped" ? run.id : null,
            now,
          }),
        );
      await hold("stopped", 2);
      await db.run((q) => releaseRunnerSetupHoldSteps(q, "stopped", 3));
      await hold("stopped", 4);
      await hold("started", 4);
      await seed(
        db,
        (q) =>
          q.orm
            .update(q.t.workItem)
            .set({ cancelRequested: 1 })
            .where(eq(q.t.workItem.id, "stopped")),
        (q) =>
          q.orm
            .update(q.t.workItem)
            .set({ state: "running" })
            .where(eq(q.t.workItem.id, "started")),
      );
      expect(await db.run((q) => getRunnerSetupHoldSteps(q, "stopped"))).toBeNull();
      expect(await db.run((q) => getRunnerSetupHoldSteps(q, "started"))).toBeNull();
      expect(await db.run((q) => takeRunnerSetupResumeSteps(q, "stopped", run.id))).toBe(false);
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

  test("an agent signing in queues one check per owner its runner serves", async () => {
    const { db, close } = await open();
    try {
      await withoutForeignKeys(db);
      await db.run((q) =>
        q.exec(
          q.orm.insert(q.t.runner).values({
            id: "box",
            workspaceId: "ws",
            ownerUserId: "u",
            name: "box",
            status: "active",
            createdAt: 0,
          }),
        ),
      );
      for (const [itemId, ownerUserId] of [
        ["mine", "u"],
        ["also", "u"],
        ["theirs", "v"],
      ] as const) {
        await insertWorkItem(db, itemId);
        await db.run((q) =>
          holdForRunnerSetupSteps(q, {
            itemId,
            ownerUserId,
            reason: "agent-not-signed-in",
            runnerId: "box",
            agent: "claude",
            now: 1,
          }),
        );
      }
      const pending = async () =>
        (
          await db.run((q) =>
            q.all(
              q.orm
                .select({ payload: q.t.job.payload })
                .from(q.t.job)
                .where(eq(q.t.job.queue, JOB_KIND.runnerSetupCheck)),
            ),
          )
        )
          .map(({ payload }) => (typeof payload === "string" ? JSON.parse(payload) : payload))
          .map((payload: { ownerUserId: string }) => payload.ownerUserId)
          .sort();
      await db.run((q) => setRunnerAgentSignedInSteps(q, "box", "claude", false, 2));
      expect(await pending()).toEqual([]);
      await db.run((q) => setRunnerAgentSignedInSteps(q, "box", "claude", true, 3));
      await db.run((q) => setRunnerAgentSignedInSteps(q, "box", "claude", true, 4));
      expect(await pending()).toEqual(["u"]);
      await enqueueRunnerSetupChecks(db, 5);
      expect(await pending()).toEqual(["u", "v"]);
    } finally {
      await close();
    }
  });
});
