import type { Database } from "bun:sqlite";

/**
 * `moving` while the runner hands the session over or Paws places it, `waiting` while no runner
 * is eligible, and `stayed` when the runner kept the session.
 */
export type RunnerSessionMoveStatus = "moving" | "waiting" | "stayed";
export type RunnerSessionMove = { status: RunnerSessionMoveStatus; reason: string | null };

/** Starts or restarts the move of `runId` off `runnerId`. */
export function requestRunnerSessionMove(
  db: Database,
  input: { runId: string; runnerId: string; userId: string | null; now: number },
): void {
  db.run(
    `INSERT INTO runner_session_move(run_id,runner_id,requested_by,status,reason,updated_at)
     VALUES(?,?,?,'moving',NULL,?) ON CONFLICT(run_id) DO UPDATE SET
     runner_id=excluded.runner_id,requested_by=excluded.requested_by,status='moving',reason=NULL,
     updated_at=excluded.updated_at`,
    [input.runId, input.runnerId, input.userId, input.now],
  );
}

/** Records how the move of `runId` off `runnerId` stands, creating it for a move Paws started. */
export function noteRunnerSessionMove(
  db: Database,
  input: {
    runId: string;
    runnerId: string;
    status: RunnerSessionMoveStatus;
    reason: string | null;
    now: number;
  },
): void {
  db.run(
    `INSERT INTO runner_session_move(run_id,runner_id,requested_by,status,reason,updated_at)
     VALUES(?,?,NULL,?,?,?) ON CONFLICT(run_id) DO UPDATE SET runner_id=excluded.runner_id,
     status=excluded.status,reason=excluded.reason,updated_at=excluded.updated_at`,
    [input.runId, input.runnerId, input.status, input.reason, input.now],
  );
}

/** Forgets the move of `runId` off `runnerId`, as when the run ended before it moved. */
export function clearRunnerSessionMove(db: Database, runId: string, runnerId: string): void {
  db.run("DELETE FROM runner_session_move WHERE run_id=? AND runner_id=?", [runId, runnerId]);
}

/** The move of `runId` off `runnerId`, or null when none was asked or it landed elsewhere. */
export function runnerSessionMove(
  db: Database,
  runId: string,
  runnerId: string,
): RunnerSessionMove | null {
  return (
    db
      .query<RunnerSessionMove, [string, string]>(
        "SELECT status,reason FROM runner_session_move WHERE run_id=? AND runner_id=?",
      )
      .get(runId, runnerId) ?? null
  );
}
