import { expect, test } from "bun:test";
import {
  ensureRestartQuestionSteps,
  holdRestartSteps,
  listJobsSteps,
  restartHoldSteps,
  restartQuestionStandsSteps,
  type WorkItemRecord,
} from "../src/db";
import { forEachDialect, insertWorkItem, seed } from "./dialects";

const item = (overrides: Partial<WorkItemRecord> = {}) =>
  ({
    id: "item",
    state: "recovering",
    sessionKey: "session",
    cancelRequested: false,
    ...overrides,
  }) as WorkItemRecord;

forEachDialect((open) => {
  test("a hold stands for its session and keeps its first request", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "item");
      expect(await db.run((q) => restartHoldSteps(q, item()))).toBeNull();
      await db.run((q) => holdRestartSteps(q, item(), 5));
      await db.run((q) => holdRestartSteps(q, item(), 6));
      expect(await db.run((q) => restartHoldSteps(q, item()))).toEqual({
        itemId: "item",
        sessionId: "session",
        requestedAt: 5,
      });
      expect(await db.run((q) => restartHoldSteps(q, item({ state: "running" })))).toBeNull();
      expect(await db.run((q) => restartHoldSteps(q, item({ cancelRequested: true })))).toBeNull();
      await db.run((q) => holdRestartSteps(q, item({ sessionKey: "next" }), 7));
      expect(await db.run((q) => restartHoldSteps(q, item()))).toBeNull();
      expect(await db.run((q) => restartHoldSteps(q, item({ sessionKey: "next" })))).toEqual({
        itemId: "item",
        sessionId: "next",
        requestedAt: 7,
      });
    } finally {
      await close();
    }
  });

  test("a held item gets one restart question", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "item");
      expect(await db.run((q) => ensureRestartQuestionSteps(q, item(), 1))).toEqual({
        held: false,
        armed: false,
      });
      await db.run((q) => holdRestartSteps(q, item(), 5));
      expect(await db.transaction((q) => ensureRestartQuestionSteps(q, item(), 6))).toEqual({
        held: true,
        armed: true,
      });
      expect(await db.transaction((q) => ensureRestartQuestionSteps(q, item(), 7))).toEqual({
        held: true,
        armed: false,
      });
      const jobs = await db.run(listJobsSteps);
      expect(
        jobs.map((job) => [job.queue, job.jobKey, (job.payload as { reason: string }).reason]),
      ).toEqual([["item.ask", "restart-ask:item:5", "restart"]]);
    } finally {
      await close();
    }
  });

  test("an open or queued restart question stands, and an answered one until its handoff", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "item");
      expect(await db.run((q) => restartQuestionStandsSteps(q, item()))).toBe(false);
      await seed(
        db,
        (q) =>
          q.orm.insert(q.t.question).values({
            id: "answered",
            itemId: "item",
            sessionId: "session",
            body: "?",
            status: "answered",
            reason: "restart",
            handoffVersion: 3,
            createdAt: 0,
          }),
        (q) =>
          q.orm.insert(q.t.question).values({
            id: "other",
            itemId: "item",
            sessionId: "session",
            body: "?",
            status: "open",
            reason: "budget",
            createdAt: 0,
          }),
      );
      expect(await db.run((q) => restartQuestionStandsSteps(q, item()))).toBe(false);
      await seed(db, (q) =>
        q.orm.insert(q.t.question).values({
          id: "queued",
          itemId: "item",
          sessionId: "session",
          body: "?",
          status: "queued",
          reason: "restart",
          createdAt: 0,
        }),
      );
      expect(await db.run((q) => restartQuestionStandsSteps(q, item()))).toBe(true);
      expect(await db.run((q) => restartQuestionStandsSteps(q, item({ sessionKey: "x" })))).toBe(
        false,
      );
    } finally {
      await close();
    }
  });
});
