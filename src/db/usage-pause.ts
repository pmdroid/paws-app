import type { Database } from "bun:sqlite";
import { and, asc, eq, gt, inArray, isNull, min, ne, sql } from "drizzle-orm";
import { systemClock } from "../core";
import { resumeAccountHealthNowSteps } from "./agent-account-health";
import { settled, sqliteDb, type Q, type Steps } from "./db";
import { accrueAwake } from "./items";
import { orm } from "./orm";
import { usagePause as usagePauseTable } from "./schema";
import { immediate } from "./tx";

/** A run waiting for its agent's usage limit to reset. */
export type UsagePause = typeof usagePauseTable.$inferSelect;

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

export function* usagePauseSteps(q: Q, runId: string): Steps<UsagePause | null> {
  const pauses = q.t.usagePause;
  const row = yield* q.one(
    q.orm
      .select({
        runId: pauses.runId,
        itemId: pauses.itemId,
        agent: pauses.agent,
        runnerId: pauses.runnerId,
        resetsAt: pauses.resetsAt,
        resumeAt: pauses.resumeAt,
        pausedAt: pauses.pausedAt,
      })
      .from(pauses)
      .where(eq(pauses.runId, runId)),
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

export function* resumeUsagePauseNowSteps(q: Q, runId: string, now: number): Steps<boolean> {
  const { usagePause: pauses, runnerAgentPolicy } = q.t;
  const pause = yield* usagePauseSteps(q, runId);
  if (!pause) return false;
  yield* q.exec(q.orm.update(pauses).set({ resumeAt: now }).where(eq(pauses.runId, runId)));
  yield* q.exec(
    q.orm
      .update(runnerAgentPolicy)
      .set({ cooldownUntil: 0 })
      .where(
        and(
          eq(runnerAgentPolicy.agent, pause.agent),
          gt(runnerAgentPolicy.cooldownUntil, 0),
          pause.runnerId === null ? undefined : eq(runnerAgentPolicy.runnerId, pause.runnerId),
        ),
      ),
  );
  yield* resumeAccountHealthNowSteps(q, pause.agent, pause.runnerId, now);
  return true;
}

/** Resume now: end the wait and lift the agent's cooldown so placement can try it again. */
export function resumeUsagePauseNow(db: Database, runId: string, now: number): boolean {
  return settled(sqliteDb(db).transaction((q) => resumeUsagePauseNowSteps(q, runId, now)));
}

export function* clearUsagePausesSteps(q: Q): Steps<void> {
  yield* q.exec(q.orm.delete(q.t.usagePause));
}

/** A pause lives in the process that waits for it; a restart starts from no waits. */
export function clearUsagePauses(db: Database): void {
  settled(sqliteDb(db).run((q) => clearUsagePausesSteps(q)));
}

type CooldownQuery = { agent: string; now: number; runnerIds: readonly string[] };

export function* earliestRunnerCooldownSteps(
  q: Q,
  input: CooldownQuery,
): Steps<{ runnerId: string; until: number } | null> {
  const { runnerAgentPolicy } = q.t;
  const row = yield* q.one(
    q.orm
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
      .limit(1),
  );
  return row ?? null;
}

export function earliestRunnerCooldown(
  db: Database,
  input: CooldownQuery,
): { runnerId: string; until: number } | null {
  return settled(sqliteDb(db).run((q) => earliestRunnerCooldownSteps(q, input)));
}

export function* runnerAgentLoginReadySteps(q: Q, runnerId: string, agent: string): Steps<boolean> {
  const { runnerAgentPolicy } = q.t;
  const row = yield* q.one(
    q.orm
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
      .limit(1),
  );
  return row !== undefined;
}

export function runnerAgentLoginReady(db: Database, runnerId: string, agent: string): boolean {
  return settled(sqliteDb(db).run((q) => runnerAgentLoginReadySteps(q, runnerId, agent)));
}

export function* usageLimitResetSteps(
  q: Q,
  agent: string,
  sessionId: string | null,
  now: number,
): Steps<number | null> {
  if (sessionId === null) return null;
  const { agentAccountHealth: h, linearSession, runner, runnerAgentPolicy: p, workspace } = q.t;
  const inScope = and(
    eq(runner.status, "active"),
    isNull(runner.revokedAt),
    inArray(
      runner.workspaceId,
      q.orm
        .select({ id: workspace.id })
        .from(workspace)
        .innerJoin(linearSession, eq(linearSession.organizationId, workspace.linearOrganizationId))
        .where(eq(linearSession.sessionId, sessionId)),
    ),
  );
  const cooldown = yield* q.one(
    q.orm
      .select({ at: min(p.cooldownUntil) })
      .from(p)
      .innerJoin(runner, eq(runner.id, p.runnerId))
      .where(and(eq(p.agent, agent), gt(p.cooldownUntil, now), inScope)),
  );
  const recheck = yield* q.one(
    q.orm
      .select({ at: min(h.nextCheckAt) })
      .from(h)
      .innerJoin(runner, eq(runner.id, h.runnerId))
      .where(
        and(
          eq(h.agent, agent),
          inArray(h.state, ["exhausted", "restricted"]),
          ne(h.scope, "binding"),
          gt(h.nextCheckAt, now),
          inScope,
        ),
      ),
  );
  const resets = [cooldown?.at, recheck?.at].filter((at): at is number => typeof at === "number");
  return resets.length ? Math.min(...resets) : null;
}

export function usageLimitReset(
  db: Database,
  agent: string,
  sessionId: string | null,
  now: number,
): number | null {
  return settled(sqliteDb(db).run((q) => usageLimitResetSteps(q, agent, sessionId, now)));
}
