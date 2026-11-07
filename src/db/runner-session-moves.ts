import type { Database } from "bun:sqlite";
import { and, desc, eq } from "drizzle-orm";
import { orm } from "./orm";
import { agentSessionSnapshot, runnerAgent, runnerCommand, runnerCommandAccount } from "./schema";

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

export type SealedSessionSnapshot = {
  generation: number;
  runnerId: string;
  ownerUserId: string;
  agent: string;
  agentVersion: string;
  sessionId: string;
  commitSha: string;
  turn: number;
  sealedSize: number;
  sha256: string;
};

export function latestSealedSnapshot(db: Database, runId: string): SealedSessionSnapshot | null {
  const row = orm(db)
    .select({
      generation: agentSessionSnapshot.generation,
      runnerId: agentSessionSnapshot.runnerId,
      ownerUserId: agentSessionSnapshot.ownerUserId,
      agent: agentSessionSnapshot.agent,
      agentVersion: agentSessionSnapshot.agentVersion,
      sessionId: agentSessionSnapshot.sessionId,
      commitSha: agentSessionSnapshot.commitSha,
      turn: agentSessionSnapshot.turn,
      sealedSize: agentSessionSnapshot.sealedSize,
      sha256: agentSessionSnapshot.sha256,
    })
    .from(agentSessionSnapshot)
    .where(and(eq(agentSessionSnapshot.runId, runId), eq(agentSessionSnapshot.status, "sealed")))
    .orderBy(desc(agentSessionSnapshot.generation))
    .limit(1)
    .get();
  return (row as SealedSessionSnapshot | undefined) ?? null;
}

export function lastRunCommandAccount(
  db: Database,
  runId: string,
  generation: number,
): { accountId: string; named: number } | null {
  return (
    orm(db)
      .select({ accountId: runnerCommandAccount.accountId, named: runnerCommandAccount.named })
      .from(runnerCommand)
      .innerJoin(runnerCommandAccount, eq(runnerCommandAccount.commandId, runnerCommand.id))
      .where(
        and(
          eq(runnerCommand.runId, runId),
          eq(runnerCommand.generation, generation),
          eq(runnerCommand.kind, "run"),
        ),
      )
      .orderBy(desc(runnerCommand.ordinal))
      .limit(1)
      .get() ?? null
  );
}

export function currentRunnerAgentVersion(
  db: Database,
  runnerId: string,
  agent: string,
): string | null {
  return (
    orm(db)
      .select({ version: runnerAgent.version })
      .from(runnerAgent)
      .where(
        and(
          eq(runnerAgent.runnerId, runnerId),
          eq(runnerAgent.agent, agent),
          eq(runnerAgent.status, "current"),
        ),
      )
      .get()?.version ?? null
  );
}
