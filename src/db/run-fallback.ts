import type { Database } from "bun:sqlite";
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
    if (!db.query("SELECT 1 FROM run WHERE id=?").get(input.runId)) return false;
    const generation =
      db
        .query<{ generation: number }, [string, string]>(
          "SELECT generation FROM runner_work WHERE run_id=? AND runner_id=?",
        )
        .get(input.runId, input.runnerId)?.generation ?? 0;
    const account = db
      .query<{ accountId: string; bindingId: string }, [string, string, number]>(
        `SELECT a.account_id AS accountId,a.binding_id AS bindingId FROM runner_command c
         JOIN runner_command_account a ON a.command_id=c.id
         WHERE c.run_id=? AND c.runner_id=? AND c.generation=? AND c.kind IN ('run','review','task')
         ORDER BY c.ordinal DESC LIMIT 1`,
      )
      .get(input.runId, input.runnerId, generation);
    const ordinal =
      db
        .query<{ ordinal: number }, [string, string]>(
          "SELECT COALESCE(MAX(ordinal),0) AS ordinal FROM run_fallback_attempt WHERE run_id=? AND call_id=?",
        )
        .get(input.runId, input.callId)!.ordinal + 1;
    if (ordinal > MAX_FALLBACK_ATTEMPTS) return false;
    return (
      db
        .query(
          `INSERT OR IGNORE INTO run_fallback_attempt(run_id,call_id,ordinal,policy_key,outcome,
           runner_id,generation,excluded_key,account_id,binding_id,recorded_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          input.runId,
          input.callId,
          ordinal,
          input.policyKey,
          input.outcome,
          input.runnerId,
          generation,
          input.excludedKey,
          account?.accountId ?? null,
          account?.bindingId ?? null,
          input.now,
        ).changes > 0
    );
  });
}

export function fallbackHistory(
  db: Database,
  runId: string,
  callId: string,
  policyKey: string,
): FallbackHistory {
  const rows = db
    .query<{ outcome: FallbackOutcome; excludedKey: string }, [string, string, string]>(
      `SELECT outcome,excluded_key AS excludedKey FROM run_fallback_attempt
       WHERE run_id=? AND call_id=? AND policy_key=? AND closed_at IS NULL ORDER BY ordinal`,
    )
    .all(runId, callId, policyKey);
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
  db.run(
    "UPDATE run_fallback_attempt SET closed_at=? WHERE run_id=? AND call_id=? AND closed_at IS NULL",
    [now, runId, callId],
  );
}
