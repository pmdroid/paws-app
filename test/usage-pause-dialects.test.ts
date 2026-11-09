import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  clearUsagePausesSteps,
  earliestRunnerCooldownSteps,
  resumeUsagePauseNowSteps,
  runnerAgentLoginReadySteps,
  usagePauseSteps,
  type Db,
} from "../src/db";
import { forEachDialect, seed, withoutForeignKeys } from "./dialects";

const pause = {
  runId: "run",
  itemId: "item",
  agent: "codex",
  runnerId: "box",
  resetsAt: null,
  resumeAt: 100,
  pausedAt: 10,
};

function policies(db: Db, ...rows: [runnerId: string, cooldownUntil: number, ready?: number][]) {
  return seed(
    db,
    ...rows.map(
      ([runnerId, cooldownUntil, ready = 1]) =>
        (q: Parameters<Parameters<typeof seed>[1]>[0]) =>
          q.orm
            .insert(q.t.runnerAgentPolicy)
            .values({ runnerId, agent: "codex", cooldownUntil, ready }),
    ),
  );
}

function cooldowns(db: Db) {
  return db.run((q) =>
    q.all(
      q.orm
        .select({
          runnerId: q.t.runnerAgentPolicy.runnerId,
          until: q.t.runnerAgentPolicy.cooldownUntil,
        })
        .from(q.t.runnerAgentPolicy)
        .orderBy(q.t.runnerAgentPolicy.runnerId),
    ),
  );
}

forEachDialect((open) => {
  test("resuming a pause now lifts its runner's cooldown and quota recheck", async () => {
    const { db, close } = await open();
    try {
      await withoutForeignKeys(db);
      expect(await db.transaction((q) => resumeUsagePauseNowSteps(q, "run", 50))).toBe(false);
      await seed(db, (q) => q.orm.insert(q.t.usagePause).values(pause));
      await policies(db, ["box", 200], ["other", 200]);
      await seed(db, (q) =>
        q.orm.insert(q.t.agentAccountHealth).values({
          kind: "quota",
          scope: "binding",
          scopeId: "binding",
          workspaceId: "acme",
          agent: "codex",
          state: "exhausted",
          source: "result",
          sourceId: "s",
          bindingId: "binding",
          runnerId: "box",
          observedAt: 0,
          nextCheckAt: 300,
          updatedAt: 0,
        }),
      );
      expect(await db.run((q) => usagePauseSteps(q, "run"))).toEqual(pause);
      expect(await db.transaction((q) => resumeUsagePauseNowSteps(q, "run", 50))).toBe(true);
      expect((await db.run((q) => usagePauseSteps(q, "run")))?.resumeAt).toBe(50);
      expect(await cooldowns(db)).toEqual([
        { runnerId: "box", until: 0 },
        { runnerId: "other", until: 200 },
      ]);
      const health = await db.run((q) =>
        q.one(
          q.orm
            .select({
              nextCheckAt: q.t.agentAccountHealth.nextCheckAt,
              updatedAt: q.t.agentAccountHealth.updatedAt,
            })
            .from(q.t.agentAccountHealth)
            .where(eq(q.t.agentAccountHealth.runnerId, "box")),
        ),
      );
      expect(health).toEqual({ nextCheckAt: 50, updatedAt: 50 });
      await db.run(clearUsagePausesSteps);
      expect(await db.run((q) => usagePauseSteps(q, "run"))).toBeNull();
    } finally {
      await close();
    }
  });

  test("the earliest cooldown among the runners, and login readiness", async () => {
    const { db, close } = await open();
    try {
      await withoutForeignKeys(db);
      await policies(db, ["a", 30], ["b", 20], ["c", 10], ["d", 5, 0]);
      const earliest = (runnerIds: string[]) =>
        db.run((q) => earliestRunnerCooldownSteps(q, { agent: "codex", now: 15, runnerIds }));
      expect(await earliest(["a", "b", "c"])).toEqual({ runnerId: "b", until: 20 });
      expect(await earliest(["c"])).toBeNull();
      expect(await earliest([])).toBeNull();
      expect(await db.run((q) => runnerAgentLoginReadySteps(q, "a", "codex"))).toBe(true);
      expect(await db.run((q) => runnerAgentLoginReadySteps(q, "d", "codex"))).toBe(false);
      expect(await db.run((q) => runnerAgentLoginReadySteps(q, "a", "claude"))).toBe(false);
    } finally {
      await close();
    }
  });
});
