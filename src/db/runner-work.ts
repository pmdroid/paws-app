import type { Database } from "bun:sqlite";
import { and, count, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { settled, sqliteDb, type Q } from "./db";
import { jsonText } from "./json-text";
import { workHelperSql } from "./runner-capacity";
import { runnerLeaseCutoff } from "./runner-lease";

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

/** Whether a helper that takes the runner's single health lane has not finished yet. */
export function* runnerLaneHelperWaitingSteps(q: Q, runnerId: string, now: number) {
  const { runnerHelper } = q.t;
  const helper = yield* q.one(
    q.orm
      .select({ id: runnerHelper.id })
      .from(runnerHelper)
      .where(
        and(
          eq(runnerHelper.runnerId, runnerId),
          isNull(runnerHelper.endedAt),
          isNull(runnerHelper.result),
          gt(runnerHelper.expiresAt, now),
          workHelperSql(q, "runner_helper"),
        ),
      )
      .limit(1),
  );
  return helper !== undefined;
}

export function runnerLaneHelperWaiting(db: Database, runnerId: string, now: number): boolean {
  return settled(sqliteDb(db).run((q) => runnerLaneHelperWaitingSteps(q, runnerId, now)));
}

/** What the routine sign-in checks need to know about each agent on a runner. */
export function* runnerAgentCheckStatesSteps(q: Q, runnerId: string) {
  const { runnerAgentPolicy } = q.t;
  return yield* q.all(
    q.orm
      .select({
        agent: runnerAgentPolicy.agent,
        authExpired: runnerAgentPolicy.authExpired,
        lastUsedAt: runnerAgentPolicy.lastUsedAt,
      })
      .from(runnerAgentPolicy)
      .where(eq(runnerAgentPolicy.runnerId, runnerId)),
  );
}

export function runnerAgentCheckStates(db: Database, runnerId: string) {
  return settled(sqliteDb(db).run((q) => runnerAgentCheckStatesSteps(q, runnerId)));
}

/**
 * The one probe or sign-in check the runner may be sent now, or null while another health
 * command runs, or a helper or a sign-in someone started waits. The runner keeps delivered
 * commands in arrival order and runs one at a time, so routine checks go out one by one, last.
 */
export function* nextRoutineHealthCommandSteps(q: Q, runnerId: string, now: number) {
  const { runnerCommand, runnerHealthResult, runnerLogin } = q.t;
  if (yield* runnerLaneHelperWaitingSteps(q, runnerId, now)) return null;
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

export function* runnerAgentOpenWorkCountSteps(q: Q, runnerId: string, agent: string, at: number) {
  const { runnerWork: w, run } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ count: count() })
      .from(w)
      .innerJoin(run, eq(run.id, w.runId))
      .where(
        and(
          eq(w.runnerId, runnerId),
          eq(run.agent, agent),
          isNull(w.endedAt),
          gt(w.leaseUntil, runnerLeaseCutoff(at)),
        ),
      ),
  );
  return row!.count;
}

export function runnerAgentOpenWorkCount(
  db: Database,
  runnerId: string,
  agent: string,
  at: number,
): number {
  return settled(sqliteDb(db).run((q) => runnerAgentOpenWorkCountSteps(q, runnerId, agent, at)));
}

export function* runnerHasOpenWorkSteps(q: Q, runnerId: string, at: number) {
  const { runnerWork: w, runnerHelper: h } = q.t;
  const work = yield* q.one(
    q.orm
      .select({ runId: w.runId })
      .from(w)
      .where(
        and(eq(w.runnerId, runnerId), isNull(w.endedAt), gt(w.leaseUntil, runnerLeaseCutoff(at))),
      )
      .limit(1),
  );
  if (work) return true;
  const helper = yield* q.one(
    q.orm
      .select({ id: h.id })
      .from(h)
      .where(and(eq(h.runnerId, runnerId), isNull(h.endedAt), gt(h.expiresAt, at)))
      .limit(1),
  );
  return helper !== undefined;
}

export function runnerHasOpenWork(db: Database, runnerId: string, at: number): boolean {
  return settled(sqliteDb(db).run((q) => runnerHasOpenWorkSteps(q, runnerId, at)));
}

export type RunnerAgentPolicyState = {
  ready: number;
  authExpired: number;
  extraUsage: number;
  quotaState: string;
  resetsAt: number | null;
  cooldownUntil: number;
};

export function* runnerAgentPolicyStateSteps(q: Q, runnerId: string, agent: string) {
  const { runnerAgentPolicy: p } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        ready: p.ready,
        authExpired: p.authExpired,
        extraUsage: p.extraUsage,
        quotaState: p.quotaState,
        resetsAt: p.resetsAt,
        cooldownUntil: p.cooldownUntil,
      })
      .from(p)
      .where(and(eq(p.runnerId, runnerId), eq(p.agent, agent))),
  );
  return row ?? null;
}

export function runnerAgentPolicyState(
  db: Database,
  runnerId: string,
  agent: string,
): RunnerAgentPolicyState | null {
  return settled(sqliteDb(db).run((q) => runnerAgentPolicyStateSteps(q, runnerId, agent)));
}

export function* setRunnerAgentSignedInSteps(
  q: Q,
  runnerId: string,
  agent: string,
  signedIn: boolean,
) {
  const { runnerAgentPolicy: p } = q.t;
  const state = { ready: signedIn ? 1 : 0, authExpired: signedIn ? 0 : 1 };
  yield* q.exec(
    q.orm
      .insert(p)
      .values({ runnerId, agent, ...state })
      .onConflictDoUpdate({ target: [p.runnerId, p.agent], set: state }),
  );
}

export function setRunnerAgentSignedIn(
  db: Database,
  runnerId: string,
  agent: string,
  signedIn: boolean,
): void {
  settled(sqliteDb(db).run((q) => setRunnerAgentSignedInSteps(q, runnerId, agent, signedIn)));
}

type RunnerAgentQuota = {
  quotaState: string;
  resetsAt: number | null;
  cooldownUntil: number;
};

export function* setRunnerAgentQuotaSteps(
  q: Q,
  runnerId: string,
  agent: string,
  quota: RunnerAgentQuota,
) {
  const { runnerAgentPolicy: p } = q.t;
  yield* q.exec(
    q.orm
      .update(p)
      .set(quota)
      .where(and(eq(p.runnerId, runnerId), eq(p.agent, agent))),
  );
}

export function setRunnerAgentQuota(
  db: Database,
  runnerId: string,
  agent: string,
  quota: RunnerAgentQuota,
): void {
  settled(sqliteDb(db).run((q) => setRunnerAgentQuotaSteps(q, runnerId, agent, quota)));
}
