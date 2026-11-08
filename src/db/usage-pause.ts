import type { Database } from "bun:sqlite";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { systemClock } from "../core";
import { resumeAccountHealthNow } from "./agent-account-health";
import { settled, sqliteDb, type Q } from "./db";
import { accrueAwake } from "./items";
import { orm } from "./orm";
import { runnerAgentPolicy, usagePause as usagePauseTable } from "./schema";
import { immediate } from "./tx";

/** A run waiting for its agent's usage limit to reset. */
export type UsagePause = {
  runId: string;
  itemId: string;
  agent: string;
  runnerId: string | null;
  resetsAt: number | null;
  resumeAt: number;
  pausedAt: number;
};

export function startUsagePause(db: Database, pause: UsagePause, mono = systemClock.mono()): void {
  immediate(db, () => {
    accrueAwake(db, pause.itemId, mono, pause.pausedAt);
    orm(db)
      .insert(usagePauseTable)
      .values({
        runId: pause.runId,
        itemId: pause.itemId,
        agent: pause.agent,
        runnerId: pause.runnerId,
        resetsAt: pause.resetsAt,
        resumeAt: pause.resumeAt,
        pausedAt: pause.pausedAt,
      })
      .onConflictDoUpdate({
        target: usagePauseTable.runId,
        set: {
          agent: pause.agent,
          runnerId: pause.runnerId,
          resetsAt: pause.resetsAt,
          resumeAt: pause.resumeAt,
          pausedAt: pause.pausedAt,
        },
      })
      .run();
  });
}

export function* usagePauseSteps(q: Q, runId: string) {
  const { usagePause } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        runId: usagePause.runId,
        itemId: usagePause.itemId,
        agent: usagePause.agent,
        runnerId: usagePause.runnerId,
        resetsAt: usagePause.resetsAt,
        resumeAt: usagePause.resumeAt,
        pausedAt: usagePause.pausedAt,
      })
      .from(usagePause)
      .where(eq(usagePause.runId, runId)),
  );
  return row ?? null;
}

export function usagePause(db: Database, runId: string): UsagePause | null {
  return settled(sqliteDb(db).run((q) => usagePauseSteps(q, runId)));
}

export function endUsagePause(
  db: Database,
  runId: string,
  mono = systemClock.mono(),
  now = systemClock.now(),
): void {
  immediate(db, () => {
    const pause = usagePause(db, runId);
    if (pause) accrueAwake(db, pause.itemId, mono, now);
    orm(db).delete(usagePauseTable).where(eq(usagePauseTable.runId, runId)).run();
  });
}

/** Resume now: end the wait and lift the agent's cooldown so placement can try it again. */
export function resumeUsagePauseNow(db: Database, runId: string, now: number): boolean {
  return db
    .transaction(() => {
      const pause = usagePause(db, runId);
      if (!pause) return false;
      orm(db)
        .update(usagePauseTable)
        .set({ resumeAt: now })
        .where(eq(usagePauseTable.runId, runId))
        .run();
      orm(db)
        .update(runnerAgentPolicy)
        .set({ cooldownUntil: 0 })
        .where(
          and(
            eq(runnerAgentPolicy.agent, pause.agent),
            gt(runnerAgentPolicy.cooldownUntil, 0),
            pause.runnerId === null ? undefined : eq(runnerAgentPolicy.runnerId, pause.runnerId),
          ),
        )
        .run();
      resumeAccountHealthNow(db, pause.agent, pause.runnerId, now);
      return true;
    })
    .immediate();
}

/** A pause lives in the process that waits for it; a restart starts from no waits. */
export function clearUsagePauses(db: Database): void {
  orm(db).delete(usagePauseTable).run();
}

export function earliestRunnerCooldown(
  db: Database,
  input: { agent: string; now: number; runnerIds: readonly string[] },
): { runnerId: string; until: number } | null {
  return (
    orm(db)
      .select({ runnerId: runnerAgentPolicy.runnerId, until: runnerAgentPolicy.cooldownUntil })
      .from(runnerAgentPolicy)
      .where(
        and(
          eq(runnerAgentPolicy.agent, input.agent),
          gt(runnerAgentPolicy.cooldownUntil, input.now),
          inArray(runnerAgentPolicy.runnerId, [...input.runnerIds]),
        ),
      )
      .orderBy(asc(runnerAgentPolicy.cooldownUntil), asc(runnerAgentPolicy.runnerId))
      .limit(1)
      .get() ?? null
  );
}

export function runnerAgentLoginReady(db: Database, runnerId: string, agent: string): boolean {
  return (
    orm(db)
      .select({ one: sql`1` })
      .from(runnerAgentPolicy)
      .where(
        and(
          eq(runnerAgentPolicy.runnerId, runnerId),
          eq(runnerAgentPolicy.agent, agent),
          eq(runnerAgentPolicy.ready, 1),
          eq(runnerAgentPolicy.authExpired, 0),
        ),
      )
      .get() !== undefined
  );
}
