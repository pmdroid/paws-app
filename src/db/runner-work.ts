import type { Database } from "bun:sqlite";
import { and, desc, eq, exists, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
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

export type ItemRunResult = {
  runnerId: string;
  envelope: string;
  payload: string;
  receivedAt: number;
};

export function* itemRunResultsSteps(q: Q, itemId: string, limit?: number) {
  const { run, runnerCommand, runnerResult } = q.t;
  const query = q.orm
    .select({
      runnerId: runnerCommand.runnerId,
      envelope: jsonText(q, runnerCommand.envelope),
      payload: jsonText(q, runnerResult.payload),
      receivedAt: runnerResult.receivedAt,
    })
    .from(runnerResult)
    .innerJoin(runnerCommand, eq(runnerCommand.id, runnerResult.commandId))
    .innerJoin(run, eq(run.id, runnerResult.runId))
    .where(and(eq(run.itemId, itemId), eq(runnerCommand.kind, "run")))
    .orderBy(desc(runnerResult.receivedAt), desc(runnerResult.generation));
  return yield* q.all(limit === undefined ? query : query.limit(limit));
}

export function itemRunResults(db: Database, itemId: string, limit?: number): ItemRunResult[] {
  return settled(sqliteDb(db).run((q) => itemRunResultsSteps(q, itemId, limit)));
}

export function* runnerWorkCommandSteps(q: Q, runId: string) {
  const { runnerCommand, runnerWork } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        runnerId: runnerWork.runnerId,
        kind: runnerCommand.kind,
        envelope: jsonText(q, runnerCommand.envelope),
      })
      .from(runnerWork)
      .leftJoin(runnerCommand, eq(runnerCommand.id, runnerWork.commandId))
      .where(eq(runnerWork.runId, runId)),
  );
  return row ?? null;
}

export function runnerWorkCommand(
  db: Database,
  runId: string,
): { runnerId: string; kind: string | null; envelope: string | null } | null {
  return settled(sqliteDb(db).run((q) => runnerWorkCommandSteps(q, runId)));
}

export function* runnerWorkRunnersSteps(q: Q, runIds: readonly string[]) {
  const { runnerWork } = q.t;
  if (runIds.length === 0) return new Map<string, string>();
  const rows = yield* q.all(
    q.orm
      .select({ runId: runnerWork.runId, runnerId: runnerWork.runnerId })
      .from(runnerWork)
      .where(inArray(runnerWork.runId, [...runIds])),
  );
  return new Map(rows.map((row) => [row.runId, row.runnerId]));
}

export function runnerWorkRunners(db: Database, runIds: readonly string[]): Map<string, string> {
  return settled(sqliteDb(db).run((q) => runnerWorkRunnersSteps(q, runIds)));
}

export function* attachableRunnerWorkSteps(q: Q, runId: string, leaseCutoff: number) {
  const { runnerCommand, runnerResult, runnerWork } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        runnerId: runnerWork.runnerId,
        workspaceId: runnerWork.workspaceId,
        envelope: jsonText(q, runnerCommand.envelope),
        cursor: runnerWork.consumedSequence,
        generation: runnerWork.generation,
      })
      .from(runnerWork)
      .innerJoin(runnerCommand, eq(runnerCommand.id, runnerWork.commandId))
      .where(
        and(
          eq(runnerWork.runId, runId),
          isNull(runnerWork.endedAt),
          or(
            gt(runnerWork.leaseUntil, leaseCutoff),
            exists(
              q.orm
                .select({ one: sql`1` })
                .from(runnerResult)
                .where(
                  and(
                    eq(runnerResult.runId, runnerWork.runId),
                    eq(runnerResult.generation, runnerWork.generation),
                    eq(runnerResult.commandId, runnerWork.commandId),
                  ),
                ),
            ),
          ),
        ),
      ),
  );
  return row ?? null;
}

export function attachableRunnerWork(
  db: Database,
  runId: string,
  leaseCutoff: number,
): {
  runnerId: string;
  workspaceId: string;
  envelope: string;
  cursor: number;
  generation: number;
} | null {
  return settled(sqliteDb(db).run((q) => attachableRunnerWorkSteps(q, runId, leaseCutoff)));
}

export function* runnerWorkGenerationSteps(q: Q, runId: string) {
  const { runnerWork } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ generation: runnerWork.generation })
      .from(runnerWork)
      .where(eq(runnerWork.runId, runId)),
  );
  return row?.generation ?? null;
}

export function runnerWorkGeneration(db: Database, runId: string): number | null {
  return settled(sqliteDb(db).run((q) => runnerWorkGenerationSteps(q, runId)));
}

export function* runnerWorkLivenessSteps(q: Q, runId: string, generation: number) {
  const { runnerWork } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ confirmedAt: runnerWork.confirmedAt, lostAt: runnerWork.lostAt })
      .from(runnerWork)
      .where(and(eq(runnerWork.runId, runId), eq(runnerWork.generation, generation))),
  );
  return row ?? null;
}

export function runnerWorkLiveness(
  db: Database,
  runId: string,
  generation: number,
): { confirmedAt: number | null; lostAt: number | null } | null {
  return settled(sqliteDb(db).run((q) => runnerWorkLivenessSteps(q, runId, generation)));
}

export type UnreachableWork = {
  runId: string;
  generation: number;
  leaseCutoff: number;
  seenBefore: number;
};

export function* runnerWorkUnreachableSteps(q: Q, input: UnreachableWork) {
  const { runner, runnerWork } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(runnerWork)
      .innerJoin(runner, eq(runner.id, runnerWork.runnerId))
      .where(
        and(
          eq(runnerWork.runId, input.runId),
          eq(runnerWork.generation, input.generation),
          isNull(runnerWork.endedAt),
          gt(runnerWork.leaseUntil, input.leaseCutoff),
          sql`COALESCE(${runner.lastSeenAt}, 0) <= ${input.seenBefore}`,
        ),
      )
      .limit(1),
  );
  return row !== undefined;
}

export function runnerWorkUnreachable(db: Database, input: UnreachableWork): boolean {
  return settled(sqliteDb(db).run((q) => runnerWorkUnreachableSteps(q, input)));
}

export function* consumeRunnerWorkSequenceSteps(
  q: Q,
  runId: string,
  generation: number,
  sequence: number,
) {
  const { runnerWork } = q.t;
  yield* q.exec(
    q.orm
      .update(runnerWork)
      .set({ consumedSequence: sequence })
      .where(and(eq(runnerWork.runId, runId), eq(runnerWork.generation, generation))),
  );
}

export function consumeRunnerWorkSequence(
  db: Database,
  runId: string,
  generation: number,
  sequence: number,
): void {
  settled(sqliteDb(db).run((q) => consumeRunnerWorkSequenceSteps(q, runId, generation, sequence)));
}

export function* loseRunnerWorkSteps(q: Q, runId: string, generation: number, at: number) {
  const { runnerWork, runnerWorkGrant } = q.t;
  yield* q.exec(
    q.orm
      .update(runnerWork)
      .set({ endedAt: at, lostAt: at })
      .where(
        and(
          eq(runnerWork.runId, runId),
          eq(runnerWork.generation, generation),
          isNull(runnerWork.endedAt),
        ),
      ),
  );
  yield* q.exec(q.orm.delete(runnerWorkGrant).where(eq(runnerWorkGrant.runId, runId)));
}

export function loseRunnerWork(db: Database, runId: string, generation: number, at: number): void {
  settled(sqliteDb(db).run((q) => loseRunnerWorkSteps(q, runId, generation, at)));
}
