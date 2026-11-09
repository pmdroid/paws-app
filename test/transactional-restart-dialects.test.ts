import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  applyDecisionSteps,
  endUsagePauseSteps,
  fixRoundsSteps,
  getWorkItemSteps,
  listJobsSteps,
  restartSteps,
  startUsagePauseSteps,
  usagePauseSteps,
} from "../src/db";
import { forEachDialect, insertWorkItem, seed, withoutForeignKeys } from "./dialects";

forEachDialect((open) => {
  test("restart fences stale callers, persists its handoff and rolls back failed admission", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "item");
      await seed(db, (q) =>
        q.orm.update(q.t.workItem).set({ state: "verifying" }).where(eq(q.t.workItem.id, "item")),
      );
      const item = (await db.run((q) => getWorkItemSteps(q, "item")))!;
      const handoff = { reason: "ci" as const, body: "Fix CI", now: 10 };
      const result = await db.transaction((q) => restartSteps(q, item, handoff));
      expect(result?.armed).toBe(true);
      expect(await db.run((q) => fixRoundsSteps(q, "item"))).toBe(1);
      expect((await db.run((q) => listJobsSteps(q)))[0]?.payload).toMatchObject({
        handoff: "Fix CI",
        reason: "ci",
      });
      expect(await db.transaction((q) => restartSteps(q, item, handoff))).toBeNull();
      const current = (await db.run((q) => getWorkItemSteps(q, "item")))!;
      await expect(
        db.transaction(function* (q) {
          yield* restartSteps(q, current, { ...handoff, now: 20 });
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      expect(await db.run((q) => getWorkItemSteps(q, "item"))).toEqual(current);
      expect(await db.run((q) => fixRoundsSteps(q, "item"))).toBe(1);
    } finally {
      await close();
    }
  });

  test("usage pauses upsert and end, including an absent pause", async () => {
    const { db, close } = await open();
    try {
      await withoutForeignKeys(db);
      await insertWorkItem(db, "item");
      const pause = {
        runId: "run",
        itemId: "item",
        agent: "codex",
        runnerId: null,
        resetsAt: null,
        resumeAt: 100,
        pausedAt: 10,
      };
      await db.transaction((q) => startUsagePauseSteps(q, pause, 10));
      await db.transaction((q) => startUsagePauseSteps(q, { ...pause, resumeAt: 200 }, 20));
      expect(await db.run((q) => usagePauseSteps(q, "run"))).toEqual({ ...pause, resumeAt: 200 });
      await db.transaction((q) => endUsagePauseSteps(q, "run", 30, 30));
      expect(await db.run((q) => usagePauseSteps(q, "run"))).toBeNull();
      await db.transaction((q) => endUsagePauseSteps(q, "run", 40, 40));
    } finally {
      await close();
    }
  });

  test("startup decisions resume, reverify, retain a merge payload and ask on repeated loss", async () => {
    const { db, close } = await open();
    try {
      for (const id of ["resume", "verify", "merge", "ask", "none"]) await insertWorkItem(db, id);
      await seed(db, (q) =>
        q.orm
          .update(q.t.workItem)
          .set({ state: "recovering", sessionKey: "session" })
          .where(eq(q.t.workItem.id, "ask")),
      );
      for (const [id, decision] of [
        ["resume", { type: "resume", freshSession: true, checkpoint: null }],
        ["verify", { type: "reverify" }],
        ["merge", { type: "keep_place", mergeCallInFlight: false }],
        ["ask", { type: "ask_restart" }],
        ["none", { type: "none" }],
      ] as const) {
        const item = (await db.run((q) => getWorkItemSteps(q, id)))!;
        expect(await db.transaction((q) => applyDecisionSteps(q, item, decision, 10))).toBe(
          id !== "none",
        );
      }
      const merge = (await db.run((q) => getWorkItemSteps(q, "merge")))!;
      expect(
        await db.transaction((q) =>
          applyDecisionSteps(q, merge, { type: "keep_place", mergeCallInFlight: true }, 5),
        ),
      ).toBe(false);
      const jobs = await db.run((q) => listJobsSteps(q));
      expect(jobs).toHaveLength(4);
      expect(jobs.find((job) => job.queue === "github.merge")?.payload).toMatchObject({
        mergeCallInFlight: true,
      });
    } finally {
      await close();
    }
  });
});
