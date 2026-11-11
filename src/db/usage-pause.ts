import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { systemClock } from "../core";
import { resumeAccountHealthNowSteps } from "./agent-account-health";
import { type Db, type Q, type Steps } from "./db";
import { accrueAwakeSteps } from "./items";
import { usagePause as usagePauseTable } from "./schema";

/** A run waiting for its agent's usage limit to reset. */
export type UsagePause = typeof usagePauseTable.$inferSelect;

export async function startUsagePause(
  store: Db,
  pause: UsagePause,
  mono = systemClock.mono(),
): Promise<void> {
  await store.transaction((q) => startUsagePauseSteps(q, pause, mono));
}

export function* startUsagePauseSteps(
  q: Q,
  pause: UsagePause,
  mono = systemClock.mono(),
): Steps<void> {
  const usagePauseTable = q.t.usagePause;
  yield* accrueAwakeSteps(q, pause.itemId, mono, pause.pausedAt);
  yield* q.exec(
    q.orm
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
      }),
  );
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

export async function usagePause(store: Db, runId: string): Promise<UsagePause | null> {
  return store.run((q) => usagePauseSteps(q, runId));
}

export async function endUsagePause(
  store: Db,
  runId: string,
  mono = systemClock.mono(),
  now = systemClock.now(),
): Promise<void> {
  await store.transaction((q) => endUsagePauseSteps(q, runId, mono, now));
}

export function* endUsagePauseSteps(
  q: Q,
  runId: string,
  mono = systemClock.mono(),
  now = systemClock.now(),
): Steps<void> {
  const pause = yield* usagePauseSteps(q, runId);
  if (pause) yield* accrueAwakeSteps(q, pause.itemId, mono, now);
  yield* q.exec(q.orm.delete(q.t.usagePause).where(eq(q.t.usagePause.runId, runId)));
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
export async function resumeUsagePauseNow(store: Db, runId: string, now: number): Promise<boolean> {
  return store.transaction((q) => resumeUsagePauseNowSteps(q, runId, now));
}

export function* clearUsagePausesSteps(q: Q): Steps<void> {
  yield* q.exec(q.orm.delete(q.t.usagePause));
}

/** A pause lives in the process that waits for it; a restart starts from no waits. */
export async function clearUsagePauses(store: Db): Promise<void> {
  await store.run((q) => clearUsagePausesSteps(q));
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

export async function earliestRunnerCooldown(
  store: Db,
  input: CooldownQuery,
): Promise<{ runnerId: string; until: number } | null> {
  return store.run((q) => earliestRunnerCooldownSteps(q, input));
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

export async function runnerAgentLoginReady(
  store: Db,
  runnerId: string,
  agent: string,
): Promise<boolean> {
  return store.run((q) => runnerAgentLoginReadySteps(q, runnerId, agent));
}
