import type { Database } from "bun:sqlite";
import { and, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { settled, sqliteDb, type Q } from "./db";
import { jsonText } from "./json-text";

export function* itemOpenRunnerWorkRunsSteps(q: Q, itemId: string) {
  const { run, runnerWork } = q.t;
  return yield* q.all(
    q.orm
      .select({ runId: runnerWork.runId })
      .from(runnerWork)
      .innerJoin(run, eq(run.id, runnerWork.runId))
      .where(and(eq(run.itemId, itemId), isNull(runnerWork.endedAt))),
  );
}

export function itemOpenRunnerWorkRuns(db: Database, itemId: string): { runId: string }[] {
  return settled(sqliteDb(db).run((q) => itemOpenRunnerWorkRunsSteps(q, itemId)));
}

export function* itemOpenRunnerWorkSteps(q: Q, itemId: string) {
  const { run, runnerWork } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        runId: runnerWork.runId,
        runnerId: runnerWork.runnerId,
        workspaceId: runnerWork.workspaceId,
        generation: runnerWork.generation,
      })
      .from(runnerWork)
      .innerJoin(run, eq(run.id, runnerWork.runId))
      .where(and(eq(run.itemId, itemId), isNull(runnerWork.endedAt)))
      .limit(1),
  );
  return row ?? null;
}

export function itemOpenRunnerWork(
  db: Database,
  itemId: string,
): { runId: string; runnerId: string; workspaceId: string; generation: number } | null {
  return settled(sqliteDb(db).run((q) => itemOpenRunnerWorkSteps(q, itemId)));
}

export function* itemRunnerCancelWorkSteps(q: Q, itemId: string) {
  const { run, runnerWork } = q.t;
  return yield* q.all(
    q.orm
      .select({
        runId: runnerWork.runId,
        runnerId: runnerWork.runnerId,
        workspaceId: runnerWork.workspaceId,
        generation: runnerWork.generation,
        leaseUntil: runnerWork.leaseUntil,
        requested: sql<number>`CASE WHEN ${runnerWork.endedAt} IS NULL OR EXISTS (
          SELECT 1 FROM runner_command c WHERE c.run_id=${runnerWork.runId} AND c.generation=${runnerWork.generation}
          AND c.runner_id=${runnerWork.runnerId} AND c.kind='cancel' AND c.acknowledged_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM runner_command a WHERE a.runner_id=c.runner_id AND a.run_id=c.run_id
            AND a.generation=c.generation AND a.kind='cancel' AND a.ordinal>c.ordinal AND a.acknowledged_at IS NOT NULL))
          THEN 1 ELSE 0 END`.mapWith(Number),
      })
      .from(runnerWork)
      .innerJoin(run, eq(run.id, runnerWork.runId))
      .where(eq(run.itemId, itemId)),
  );
}

export function itemRunnerCancelWork(
  db: Database,
  itemId: string,
): {
  runId: string;
  runnerId: string;
  workspaceId: string;
  generation: number;
  leaseUntil: number;
  requested: number;
}[] {
  return settled(sqliteDb(db).run((q) => itemRunnerCancelWorkSteps(q, itemId)));
}

type CancelLookup = { runId: string; runnerId: string; generation: number; now: number };

export function* pendingRunnerCancelSteps(q: Q, input: CancelLookup) {
  const { runnerCommand } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ id: runnerCommand.id, expiresAt: runnerCommand.expiresAt })
      .from(runnerCommand)
      .where(
        and(
          eq(runnerCommand.runId, input.runId),
          eq(runnerCommand.runnerId, input.runnerId),
          eq(runnerCommand.generation, input.generation),
          eq(runnerCommand.kind, "cancel"),
          isNull(runnerCommand.acknowledgedAt),
          gt(runnerCommand.expiresAt, input.now),
        ),
      )
      .orderBy(desc(runnerCommand.ordinal))
      .limit(1),
  );
  return row ?? null;
}

export function pendingRunnerCancel(
  db: Database,
  input: CancelLookup,
): { id: string; expiresAt: number } | null {
  return settled(sqliteDb(db).run((q) => pendingRunnerCancelSteps(q, input)));
}

export function* itemRunnerWorkReportsSteps(q: Q, itemId: string) {
  const { run, runner, runnerCommand, runnerWork } = q.t;
  return yield* q.all(
    q.orm
      .select({
        endedAt: runnerWork.endedAt,
        confirmedAt: runnerWork.confirmedAt,
        reportedAt: runner.liveReportedAt,
        acknowledgedAt: runnerCommand.acknowledgedAt,
        expiresAt: runnerCommand.expiresAt,
      })
      .from(runnerWork)
      .innerJoin(run, eq(run.id, runnerWork.runId))
      .innerJoin(runner, eq(runner.id, runnerWork.runnerId))
      .leftJoin(runnerCommand, eq(runnerCommand.id, runnerWork.commandId))
      .where(eq(run.itemId, itemId)),
  );
}

export function itemRunnerWorkReports(
  db: Database,
  itemId: string,
): {
  endedAt: number | null;
  confirmedAt: number | null;
  reportedAt: number | null;
  acknowledgedAt: number | null;
  expiresAt: number | null;
}[] {
  return settled(sqliteDb(db).run((q) => itemRunnerWorkReportsSteps(q, itemId)));
}

export function* openRunnerWorkCommandSteps(q: Q, runId: string) {
  const { runner, runnerCommand, runnerHostStatus, runnerWork } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        runnerId: runnerWork.runnerId,
        workspaceId: runnerWork.workspaceId,
        generation: runnerWork.generation,
        envelope: jsonText(q, runnerCommand.envelope),
        lastSeen: runner.lastSeenAt,
        version: runnerHostStatus.runnerVersion,
      })
      .from(runnerWork)
      .innerJoin(runnerCommand, eq(runnerCommand.id, runnerWork.commandId))
      .innerJoin(runner, eq(runner.id, runnerWork.runnerId))
      .leftJoin(runnerHostStatus, eq(runnerHostStatus.runnerId, runnerWork.runnerId))
      .where(and(eq(runnerWork.runId, runId), isNull(runnerWork.endedAt)))
      .limit(1),
  );
  return row ?? null;
}

export function openRunnerWorkCommand(
  db: Database,
  runId: string,
): {
  runnerId: string;
  workspaceId: string;
  generation: number;
  envelope: string;
  lastSeen: number | null;
  version: string | null;
} | null {
  return settled(sqliteDb(db).run((q) => openRunnerWorkCommandSteps(q, runId)));
}

export function* runnerHandoverSentSteps(q: Q, runId: string, generation: number) {
  const { runnerCommand } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(runnerCommand)
      .where(
        and(
          eq(runnerCommand.runId, runId),
          eq(runnerCommand.generation, generation),
          eq(runnerCommand.kind, "handover"),
        ),
      )
      .limit(1),
  );
  return row !== undefined;
}

export function runnerHandoverSent(db: Database, runId: string, generation: number): boolean {
  return settled(sqliteDb(db).run((q) => runnerHandoverSentSteps(q, runId, generation)));
}

export function* runnerWorkEndedSteps(q: Q, runId: string, generation: number) {
  const { runnerWork } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(runnerWork)
      .where(
        and(
          eq(runnerWork.runId, runId),
          eq(runnerWork.generation, generation),
          isNotNull(runnerWork.endedAt),
        ),
      )
      .limit(1),
  );
  return row !== undefined;
}

export function runnerWorkEnded(db: Database, runId: string, generation: number): boolean {
  return settled(sqliteDb(db).run((q) => runnerWorkEndedSteps(q, runId, generation)));
}

export function* lastRunnerEventSequenceSteps(q: Q, runId: string, generation: number) {
  const { runnerEvent } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        sequence: sql<number>`COALESCE(MAX(${runnerEvent.sequence}),0)`.mapWith(Number),
      })
      .from(runnerEvent)
      .where(and(eq(runnerEvent.runId, runId), eq(runnerEvent.generation, generation))),
  );
  return row!.sequence;
}

export function lastRunnerEventSequence(db: Database, runId: string, generation: number): number {
  return settled(sqliteDb(db).run((q) => lastRunnerEventSequenceSteps(q, runId, generation)));
}

type EventsAfter = { runId: string; generation: number; after: number; types: readonly string[] };

export function* runnerEventsAfterSteps(q: Q, input: EventsAfter) {
  const { runnerEvent } = q.t;
  return yield* q.all(
    q.orm
      .select({
        runId: runnerEvent.runId,
        generation: runnerEvent.generation,
        sequence: runnerEvent.sequence,
        payload: jsonText(q, runnerEvent.payload),
        keyId: runnerEvent.keyId,
        payloadSha256: runnerEvent.payloadSha256,
      })
      .from(runnerEvent)
      .where(
        and(
          eq(runnerEvent.runId, input.runId),
          eq(runnerEvent.generation, input.generation),
          gt(runnerEvent.sequence, input.after),
          or(
            inArray(runnerEvent.type, [...input.types]),
            and(isNull(runnerEvent.type), isNull(runnerEvent.keyId)),
          ),
        ),
      )
      .orderBy(runnerEvent.sequence),
  );
}

export function runnerEventsAfter(
  db: Database,
  input: EventsAfter,
): {
  runId: string;
  generation: number;
  sequence: number;
  payload: string;
  keyId: string | null;
  payloadSha256: string | null;
}[] {
  return settled(sqliteDb(db).run((q) => runnerEventsAfterSteps(q, input)));
}

export function* runnerResultPayloadSteps(q: Q, runId: string, generation: number) {
  const { runnerResult } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ payload: jsonText(q, runnerResult.payload) })
      .from(runnerResult)
      .where(and(eq(runnerResult.runId, runId), eq(runnerResult.generation, generation))),
  );
  return row?.payload ?? null;
}

export function runnerResultPayload(
  db: Database,
  runId: string,
  generation: number,
): string | null {
  return settled(sqliteDb(db).run((q) => runnerResultPayloadSteps(q, runId, generation)));
}

export function* runnerWorkActiveSteps(q: Q, runId: string) {
  const { runnerWork } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        agent:
          sql<number>`CASE WHEN EXISTS(SELECT 1 FROM runner_event e WHERE e.run_id=runner_work.run_id
          AND e.generation=runner_work.generation AND e.type='activity') THEN 1 ELSE 0 END`.mapWith(
            Number,
          ),
      })
      .from(runnerWork)
      .where(eq(runnerWork.runId, runId)),
  );
  return row === undefined ? null : row.agent === 1;
}

export function runnerWorkActive(db: Database, runId: string): boolean | null {
  return settled(sqliteDb(db).run((q) => runnerWorkActiveSteps(q, runId)));
}

/**
 * The one probe or sign-in check the runner may be sent now, or null while another health
 * command runs or a sign-in someone started waits. The runner keeps delivered commands in
 * arrival order and runs one at a time, so routine checks go out one by one, after sign-ins.
 */
export function* nextRoutineHealthCommandSteps(q: Q, runnerId: string, now: number) {
  const { runnerCommand, runnerHealthResult, runnerLogin } = q.t;
  const signIn = yield* q.one(
    q.orm
      .select({ id: runnerCommand.id })
      .from(runnerCommand)
      .innerJoin(runnerLogin, eq(runnerLogin.id, runnerCommand.id))
      .where(
        and(
          eq(runnerCommand.runnerId, runnerId),
          eq(runnerCommand.kind, "login"),
          gt(runnerCommand.expiresAt, now),
          inArray(runnerLogin.state, ["starting", "waiting"]),
        ),
      )
      .limit(1),
  );
  if (signIn) return null;
  const routine = yield* q.all(
    q.orm
      .select({ ordinal: runnerCommand.ordinal, acknowledgedAt: runnerCommand.acknowledgedAt })
      .from(runnerCommand)
      .leftJoin(runnerHealthResult, eq(runnerHealthResult.commandId, runnerCommand.id))
      .where(
        and(
          eq(runnerCommand.runnerId, runnerId),
          inArray(runnerCommand.kind, ["probe", "login_check"]),
          gt(runnerCommand.expiresAt, now),
          isNull(runnerHealthResult.commandId),
        ),
      )
      .orderBy(runnerCommand.ordinal),
  );
  if (routine.some((row) => row.acknowledgedAt !== null)) return null;
  return routine[0]?.ordinal ?? null;
}

export function nextRoutineHealthCommand(
  db: Database,
  runnerId: string,
  now: number,
): number | null {
  return settled(sqliteDb(db).run((q) => nextRoutineHealthCommandSteps(q, runnerId, now)));
}

/** The runner work of every run on this branch, whichever item ran it. */
export function* branchRunnerWorkSteps(q: Q, branchName: string) {
  const { run, runnerWork, workItem } = q.t;
  return yield* q.all(
    q.orm
      .select({ runId: runnerWork.runId, endedAt: runnerWork.endedAt })
      .from(runnerWork)
      .innerJoin(run, eq(run.id, runnerWork.runId))
      .innerJoin(workItem, eq(workItem.id, run.itemId))
      .where(eq(workItem.branchName, branchName)),
  );
}

export function branchRunnerWork(
  db: Database,
  branchName: string,
): { runId: string; endedAt: number | null }[] {
  return settled(sqliteDb(db).run((q) => branchRunnerWorkSteps(q, branchName)));
}
