import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { JOB_KIND, type LinearCommand } from "../src/core";
import {
  enqueueCommandSteps,
  applyLinearCommandSteps,
  applyCommandRowsSteps,
  pauseFromLinearSteps,
  getWorkItemSteps,
  takeOverItem,
  submitCommandSteps,
  drainCommandsSteps,
} from "../src/db";
import { forEachDialect, insertWorkItem } from "./dialects";

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

forEachDialect((open) => {
  test("command transactions pause, cancel and take over on both dialects", async () => {
    const { db, close } = await open();
    try {
      for (const id of ["pause", "cancel", "manual"]) await insertWorkItem(db, id);
      const stop = (itemId: string): LinearCommand => ({
        type: "stop",
        itemId,
        source: "linear",
        requestedAt: 10,
      });
      expect(await db.transaction((q) => applyLinearCommandSteps(q, stop("pause")))).toEqual({
        applied: true,
      });
      const paused = (await db.run((q) => getWorkItemSteps(q, "pause")))!;
      expect(paused.state).toBe("paused");
      expect(await db.transaction((q) => pauseFromLinearSteps(q, paused, 11))).toEqual({
        applied: true,
      });
      expect(
        await db.transaction((q) =>
          applyCommandRowsSteps(q, { ...stop("cancel"), type: "cancel" }, 12, undefined, {}),
        ),
      ).toEqual({ applied: true });
      expect((await db.run((q) => getWorkItemSteps(q, "cancel")))?.state).toBe("cancelled");
      await db.run((q) =>
        q.exec(
          q.orm.update(q.t.workItem).set({ state: "failed" }).where(eq(q.t.workItem.id, "manual")),
        ),
      );
      expect(await takeOverItem(db, "manual", "Person", 13)).toEqual({ applied: true });
      expect((await db.run((q) => getWorkItemSteps(q, "manual")))?.state).toBe("manual");
    } finally {
      await close();
    }
  });
  test("submit and drain deliver completed commands", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "item");
      const command: LinearCommand = {
        type: "stop",
        itemId: "item",
        source: "linear",
        requestedAt: 10,
      };
      const delivered: LinearCommand[] = [];
      expect(
        await db.run((q) =>
          submitCommandSteps(
            q,
            command,
            (c) => delivered.push(c),
            () => {},
          ),
        ),
      ).toEqual({ applied: true });
      expect(delivered).toEqual([command]);
      expect(await db.run((q) => drainCommandsSteps(q, () => {}, 11))).toBe(0);
    } finally {
      await close();
    }
  });
});
