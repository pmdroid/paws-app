import type { Database } from "bun:sqlite";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { orm } from "./orm";
import { run, runFallbackAttempt, runnerCommand, runnerCommandAccount, runnerWork } from "./schema";
import { immediate } from "./tx";

export type FallbackOutcome = "failed" | "handed_over" | "usage_limit";

const MAX_FALLBACK_ATTEMPTS = 256;

export type FallbackHistory = {
  excluded: string[];
  failures: number;
  usageLimits: number;
};

export function recordFallbackAttempt(
  db: Database,
  input: {
    runId: string;
    callId: string;
    policyKey: string;
    outcome: FallbackOutcome;
    runnerId: string;
    excludedKey: string;
    now: number;
  },
): boolean {
  return immediate(db, () => {
    const q = orm(db);
    if (
      !q
        .select({ one: sql`1` })
        .from(run)
        .where(eq(run.id, input.runId))
        .get()
    )
      return false;
    const generation =
      q
        .select({ generation: runnerWork.generation })
        .from(runnerWork)
        .where(and(eq(runnerWork.runId, input.runId), eq(runnerWork.runnerId, input.runnerId)))
        .get()?.generation ?? 0;
    const account = q
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
      .limit(1)
      .get();
    const ordinal =
      q
        .select({ ordinal: sql<number>`COALESCE(MAX(${runFallbackAttempt.ordinal}),0)` })
        .from(runFallbackAttempt)
        .where(
          and(
            eq(runFallbackAttempt.runId, input.runId),
            eq(runFallbackAttempt.callId, input.callId),
          ),
        )
        .get()!.ordinal + 1;
    if (ordinal > MAX_FALLBACK_ATTEMPTS) return false;
    return (
      q
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
        .returning({ ordinal: runFallbackAttempt.ordinal })
        .get() !== undefined
    );
  });
}

export function fallbackHistory(
  db: Database,
  runId: string,
  callId: string,
  policyKey: string,
): FallbackHistory {
  const rows = orm(db)
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
    .orderBy(asc(runFallbackAttempt.ordinal))
    .all();
  const excluded: string[] = [];
  for (const row of rows)
    if (row.excludedKey && !excluded.includes(row.excludedKey)) excluded.push(row.excludedKey);
  return {
    excluded,
    failures: rows.filter((row) => row.outcome === "failed").length,
    usageLimits: rows.filter((row) => row.outcome === "usage_limit").length,
  };
}

export function closeFallbackAttempts(
  db: Database,
  runId: string,
  callId: string,
  now: number,
): void {
  orm(db)
    .update(runFallbackAttempt)
    .set({ closedAt: now })
    .where(
      and(
        eq(runFallbackAttempt.runId, runId),
        eq(runFallbackAttempt.callId, callId),
        isNull(runFallbackAttempt.closedAt),
      ),
    )
    .run();
}
