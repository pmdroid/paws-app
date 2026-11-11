import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { type Q, type Steps, type Db } from "./db";

export type FallbackOutcome = "failed" | "handed_over" | "usage_limit";

const MAX_FALLBACK_ATTEMPTS = 256;

export type FallbackHistory = {
  excluded: string[];
  failures: number;
  usageLimits: number;
};

type FallbackAttempt = {
  runId: string;
  callId: string;
  policyKey: string;
  outcome: FallbackOutcome;
  runnerId: string;
  excludedKey: string;
  now: number;
};

export function* recordFallbackAttemptSteps(q: Q, input: FallbackAttempt): Steps<boolean> {
  const { run, runFallbackAttempt, runnerCommand, runnerCommandAccount, runnerWork } = q.t;
  if (
    !(yield* q.one(
      q.orm
        .select({ one: sql`1` })
        .from(run)
        .where(eq(run.id, input.runId)),
    ))
  )
    return false;
  const work = yield* q.one(
    q.orm
      .select({ generation: runnerWork.generation })
      .from(runnerWork)
      .where(and(eq(runnerWork.runId, input.runId), eq(runnerWork.runnerId, input.runnerId))),
  );
  const generation = work?.generation ?? 0;
  const account = yield* q.one(
    q.orm
      .select({
        accountId: runnerCommandAccount.accountId,
        bindingId: runnerCommandAccount.bindingId,
      })
      .from(runnerCommand)
      .innerJoin(runnerCommandAccount, eq(runnerCommandAccount.commandId, runnerCommand.id))
      .where(
        and(
          eq(runnerCommand.runId, input.runId),
          eq(runnerCommand.runnerId, input.runnerId),
          eq(runnerCommand.generation, generation),
          inArray(runnerCommand.kind, ["run", "review", "task"]),
        ),
      )
      .orderBy(desc(runnerCommand.ordinal))
      .limit(1),
  );
  const last = yield* q.one(
    q.orm
      .select({
        ordinal: sql<number>`COALESCE(MAX(${runFallbackAttempt.ordinal}),0)`.mapWith(Number),
      })
      .from(runFallbackAttempt)
      .where(
        and(eq(runFallbackAttempt.runId, input.runId), eq(runFallbackAttempt.callId, input.callId)),
      ),
  );
  const ordinal = last!.ordinal + 1;
  if (ordinal > MAX_FALLBACK_ATTEMPTS) return false;
  const inserted = yield* q.all(
    q.orm
      .insert(runFallbackAttempt)
      .values({
        runId: input.runId,
        callId: input.callId,
        ordinal,
        policyKey: input.policyKey,
        outcome: input.outcome,
        runnerId: input.runnerId,
        generation,
        excludedKey: input.excludedKey,
        accountId: account?.accountId ?? null,
        bindingId: account?.bindingId ?? null,
        recordedAt: input.now,
      })
      .onConflictDoNothing()
      .returning({ ordinal: runFallbackAttempt.ordinal }),
  );
  return inserted.length > 0;
}

export async function recordFallbackAttempt(store: Db, input: FallbackAttempt): Promise<boolean> {
  return store.transaction((q) => recordFallbackAttemptSteps(q, input));
}

export function* fallbackHistorySteps(
  q: Q,
  runId: string,
  callId: string,
  policyKey: string,
): Steps<FallbackHistory> {
  const { runFallbackAttempt } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ outcome: runFallbackAttempt.outcome, excludedKey: runFallbackAttempt.excludedKey })
      .from(runFallbackAttempt)
      .where(
        and(
          eq(runFallbackAttempt.runId, runId),
          eq(runFallbackAttempt.callId, callId),
          eq(runFallbackAttempt.policyKey, policyKey),
          isNull(runFallbackAttempt.closedAt),
        ),
      )
      .orderBy(asc(runFallbackAttempt.ordinal)),
  );
  const excluded: string[] = [];
  for (const row of rows)
    if (row.excludedKey && !excluded.includes(row.excludedKey)) excluded.push(row.excludedKey);
  return {
    excluded,
    failures: rows.filter((row) => row.outcome === "failed").length,
    usageLimits: rows.filter((row) => row.outcome === "usage_limit").length,
  };
}

export async function fallbackHistory(
  store: Db,
  runId: string,
  callId: string,
  policyKey: string,
): Promise<FallbackHistory> {
  return store.run((q) => fallbackHistorySteps(q, runId, callId, policyKey));
}

export function* closeFallbackAttemptsSteps(
  q: Q,
  runId: string,
  callId: string,
  now: number,
): Steps<void> {
  const { runFallbackAttempt } = q.t;
  yield* q.exec(
    q.orm
      .update(runFallbackAttempt)
      .set({ closedAt: now })
      .where(
        and(
          eq(runFallbackAttempt.runId, runId),
          eq(runFallbackAttempt.callId, callId),
          isNull(runFallbackAttempt.closedAt),
        ),
      ),
  );
}

export async function closeFallbackAttempts(
  store: Db,
  runId: string,
  callId: string,
  now: number,
): Promise<void> {
  await store.run((q) => closeFallbackAttemptsSteps(q, runId, callId, now));
}
