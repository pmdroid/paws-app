import type { Database } from "bun:sqlite";
import { and, desc, eq } from "drizzle-orm";
import { settled, sqliteDb, type Q, type Steps } from "./db";

/**
 * `moving` while the runner hands the session over or Paws places it, `waiting` while no runner
 * is eligible, and `stayed` when the runner kept the session.
 */
export type RunnerSessionMoveStatus = "moving" | "waiting" | "stayed";
export type RunnerSessionMove = { status: RunnerSessionMoveStatus; reason: string | null };

type MoveRequest = { runId: string; runnerId: string; userId: string | null; now: number };

export function* requestRunnerSessionMoveSteps(q: Q, input: MoveRequest): Steps<void> {
  const moveTable = q.t.runnerSessionMove;
  const move = {
    runnerId: input.runnerId,
    requestedBy: input.userId,
    status: "moving",
    reason: null,
    updatedAt: input.now,
  };
  yield* q.exec(
    q.orm
      .insert(moveTable)
      .values({ runId: input.runId, ...move })
      .onConflictDoUpdate({ target: moveTable.runId, set: move }),
  );
}

/** Starts or restarts the move of `runId` off `runnerId`. */
export function requestRunnerSessionMove(db: Database, input: MoveRequest): void {
  settled(sqliteDb(db).run((q) => requestRunnerSessionMoveSteps(q, input)));
}

type MoveNote = {
  runId: string;
  runnerId: string;
  status: RunnerSessionMoveStatus;
  reason: string | null;
  now: number;
};

export function* noteRunnerSessionMoveSteps(q: Q, input: MoveNote): Steps<void> {
  const moveTable = q.t.runnerSessionMove;
  const move = {
    runnerId: input.runnerId,
    status: input.status,
    reason: input.reason,
    updatedAt: input.now,
  };
  yield* q.exec(
    q.orm
      .insert(moveTable)
      .values({ runId: input.runId, requestedBy: null, ...move })
      .onConflictDoUpdate({ target: moveTable.runId, set: move }),
  );
}

/** Records how the move of `runId` off `runnerId` stands, creating it for a move Paws started. */
export function noteRunnerSessionMove(db: Database, input: MoveNote): void {
  settled(sqliteDb(db).run((q) => noteRunnerSessionMoveSteps(q, input)));
}

export function* clearRunnerSessionMoveSteps(q: Q, runId: string, runnerId: string): Steps<void> {
  yield* q.exec(q.orm.delete(q.t.runnerSessionMove).where(thisMove(q, runId, runnerId)));
}

/** Forgets the move of `runId` off `runnerId`, as when the run ended before it moved. */
export function clearRunnerSessionMove(db: Database, runId: string, runnerId: string): void {
  settled(sqliteDb(db).run((q) => clearRunnerSessionMoveSteps(q, runId, runnerId)));
}

export function* runnerSessionMoveSteps(
  q: Q,
  runId: string,
  runnerId: string,
): Steps<RunnerSessionMove | null> {
  const moveTable = q.t.runnerSessionMove;
  const row = yield* q.one(
    q.orm
      .select({ status: moveTable.status, reason: moveTable.reason })
      .from(moveTable)
      .where(thisMove(q, runId, runnerId)),
  );
  return (row as RunnerSessionMove | undefined) ?? null;
}

/** The move of `runId` off `runnerId`, or null when none was asked or it landed elsewhere. */
export function runnerSessionMove(
  db: Database,
  runId: string,
  runnerId: string,
): RunnerSessionMove | null {
  return settled(sqliteDb(db).run((q) => runnerSessionMoveSteps(q, runId, runnerId)));
}

function thisMove(q: Q, runId: string, runnerId: string) {
  const moveTable = q.t.runnerSessionMove;
  return and(eq(moveTable.runId, runId), eq(moveTable.runnerId, runnerId));
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

export function* latestSealedSnapshotSteps(
  q: Q,
  runId: string,
): Steps<SealedSessionSnapshot | null> {
  const { agentSessionSnapshot } = q.t;
  const row = yield* q.one(
    q.orm
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
      .limit(1),
  );
  return (row as SealedSessionSnapshot | undefined) ?? null;
}

export function latestSealedSnapshot(db: Database, runId: string): SealedSessionSnapshot | null {
  return settled(sqliteDb(db).run((q) => latestSealedSnapshotSteps(q, runId)));
}

export function* lastRunCommandAccountSteps(
  q: Q,
  runId: string,
  generation: number,
): Steps<{ accountId: string; named: number } | null> {
  const { runnerCommand, runnerCommandAccount } = q.t;
  const row = yield* q.one(
    q.orm
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
      .limit(1),
  );
  return row ?? null;
}

export function lastRunCommandAccount(
  db: Database,
  runId: string,
  generation: number,
): { accountId: string; named: number } | null {
  return settled(sqliteDb(db).run((q) => lastRunCommandAccountSteps(q, runId, generation)));
}

export function* currentRunnerAgentVersionSteps(
  q: Q,
  runnerId: string,
  agent: string,
): Steps<string | null> {
  const { runnerAgent } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ version: runnerAgent.version })
      .from(runnerAgent)
      .where(
        and(
          eq(runnerAgent.runnerId, runnerId),
          eq(runnerAgent.agent, agent),
          eq(runnerAgent.status, "current"),
        ),
      ),
  );
  return row?.version ?? null;
}

export function currentRunnerAgentVersion(
  db: Database,
  runnerId: string,
  agent: string,
): string | null {
  return settled(sqliteDb(db).run((q) => currentRunnerAgentVersionSteps(q, runnerId, agent)));
}
