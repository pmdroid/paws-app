import { expect, test } from "bun:test";
import { JOB_KIND } from "../src/core";
import {
  fixRoundsSteps,
  latestHumanTurnSteps,
  pendingRestartHandoffSteps,
  restartLimitSteps,
  type Db,
} from "../src/db";
import { forEachDialect, insertWorkItem, json, seed } from "./dialects";

/** SQLite's job trigger sets a new row's activation to its id, so seeds follow insertion order. */
type JobRow = {
  queue?: string;
  key: string;
  payload: Record<string, unknown>;
  activation: number;
  status?: string;
  runAt?: number;
};

function jobs(db: Db, ...rows: JobRow[]) {
  return seed(
    db,
    ...rows.map(
      (row) => (q: Parameters<Parameters<typeof seed>[1]>[0]) =>
        q.orm.insert(q.t.job).values({
          queue: row.queue ?? JOB_KIND.resume,
          jobKey: row.key,
          payload: json(db, row.payload),
          status: row.status ?? "done",
          runAt: row.runAt ?? 0,
          createdAt: 0,
          activationId: row.activation,
        }),
    ),
  );
}

function events(
  db: Db,
  ...rows: [version: number, at: number, from: string, to: string, event: string][]
) {
  return seed(
    db,
    ...rows.map(
      ([version, at, fromState, toState, event]) =>
        (q: Parameters<Parameters<typeof seed>[1]>[0]) =>
          q.orm
            .insert(q.t.workItemEvent)
            .values({ itemId: "item", version, at, fromState, toState, event }),
    ),
  );
}

forEachDialect((open) => {
  test("fix rounds count since the latest human turn", async () => {
    const { db, close } = await open();
    try {
      expect(await db.run((q) => latestHumanTurnSteps(q, "item"))).toBe(0);
      expect(await db.run((q) => fixRoundsSteps(q, "item"))).toBe(0);
      await jobs(
        db,
        { key: "old-fix", payload: { itemId: "item", reason: "ci" }, activation: 1 },
        { key: "linear-turn:item:1", payload: { itemId: "item" }, activation: 2 },
        { key: "fix-1", payload: { itemId: "item", reason: "findings" }, activation: 3 },
        {
          key: "fix-2",
          payload: { itemId: "item", fixRound: true, fixRounds: 3, fixRoundsAfter: 2 },
          activation: 4,
        },
        { key: "other", payload: { itemId: "other", reason: "ci" }, activation: 5 },
        { key: "plain", payload: { itemId: "item", reason: "conflict" }, activation: 6 },
      );
      expect(await db.run((q) => latestHumanTurnSteps(q, "item"))).toBe(2);
      expect(await db.run((q) => fixRoundsSteps(q, "item"))).toBe(4);
      await jobs(db, {
        key: "answered",
        payload: { itemId: "item", reason: "answer" },
        activation: 7,
      });
      expect(await db.run((q) => latestHumanTurnSteps(q, "item"))).toBe(7);
      expect(await db.run((q) => fixRoundsSteps(q, "item"))).toBe(0);
    } finally {
      await close();
    }
  });

  test("the latest restart names its fix-attempt limit", async () => {
    const { db, close } = await open();
    try {
      expect(await db.run((q) => restartLimitSteps(q, "item"))).toBeNull();
      await jobs(
        db,
        { key: "a", payload: { itemId: "item", reason: "ci", limit: 4 }, activation: 1 },
        { key: "b", payload: { itemId: "item", limit: 9 }, activation: 2 },
      );
      expect(await db.run((q) => restartLimitSteps(q, "item"))).toBe(4);
      await jobs(db, {
        key: "c",
        payload: { itemId: "item", reason: "ci", limit: "x" },
        activation: 3,
      });
      expect(await db.run((q) => restartLimitSteps(q, "item"))).toBeNull();
    } finally {
      await close();
    }
  });

  test("a handoff stands until a turn after it settles", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "item");
      expect(await db.run((q) => pendingRestartHandoffSteps(q, "item"))).toEqual({});
      await jobs(db, {
        key: "r",
        payload: { itemId: "item", reason: "ci", handoff: "Fix CI", limit: 3 },
        activation: 1,
        status: "pending",
        runAt: 10,
      });
      expect(await db.run((q) => pendingRestartHandoffSteps(q, "item"))).toEqual({
        handoff: "Fix CI",
        limit: 3,
      });
      await seed(db, (q) => q.orm.update(q.t.job).set({ status: "done" }));
      // Done, and no turn since: nothing to recover.
      expect(await db.run((q) => pendingRestartHandoffSteps(q, "item"))).toEqual({});
      await events(
        db,
        [1, 11, "queued", "running", "dispatched"],
        [2, 12, "running", "recovering", "lease_expired"],
      );
      expect(await db.run((q) => pendingRestartHandoffSteps(q, "item"))).toEqual({
        handoff: "Fix CI",
        limit: 3,
      });
      await events(
        db,
        [3, 13, "recovering", "running", "dispatched"],
        [4, 14, "running", "verifying", "turn_ended"],
      );
      expect(await db.run((q) => pendingRestartHandoffSteps(q, "item"))).toEqual({});
    } finally {
      await close();
    }
  });
});
