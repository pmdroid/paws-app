import {
  and,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { type Q, type Steps, type Db } from "./db";
import { jsonFromText, jsonText, jsonValue } from "./json-text";
import { runnerSignInWaitingSteps, workHelperSql } from "./runner-capacity";
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

export async function itemOpenRunnerWorkRuns(
  store: Db,
  itemId: string,
): Promise<{ runId: string }[]> {
  return store.run((q) => itemOpenRunnerWorkRunsSteps(q, itemId));
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

export async function itemOpenRunnerWork(
  store: Db,
  itemId: string,
): Promise<{ runId: string; runnerId: string; workspaceId: string; generation: number } | null> {
  return store.run((q) => itemOpenRunnerWorkSteps(q, itemId));
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

export async function itemRunnerCancelWork(
  store: Db,
  itemId: string,
): Promise<
  {
    runId: string;
    runnerId: string;
    workspaceId: string;
    generation: number;
    leaseUntil: number;
    requested: number;
  }[]
> {
  return store.run((q) => itemRunnerCancelWorkSteps(q, itemId));
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

export async function pendingRunnerCancel(
  store: Db,
  input: CancelLookup,
): Promise<{ id: string; expiresAt: number } | null> {
  return store.run((q) => pendingRunnerCancelSteps(q, input));
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

export async function openRunnerWorkCommand(
  store: Db,
  runId: string,
): Promise<{
  runnerId: string;
  workspaceId: string;
  generation: number;
  envelope: string;
  lastSeen: number | null;
  version: string | null;
} | null> {
  return store.run((q) => openRunnerWorkCommandSteps(q, runId));
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

export async function runnerHandoverSent(
  store: Db,
  runId: string,
  generation: number,
): Promise<boolean> {
  return store.run((q) => runnerHandoverSentSteps(q, runId, generation));
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

export async function runnerWorkEnded(
  store: Db,
  runId: string,
  generation: number,
): Promise<boolean> {
  return store.run((q) => runnerWorkEndedSteps(q, runId, generation));
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

export async function lastRunnerEventSequence(
  store: Db,
  runId: string,
  generation: number,
): Promise<number> {
  return store.run((q) => lastRunnerEventSequenceSteps(q, runId, generation));
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

export async function runnerEventsAfter(
  store: Db,
  input: EventsAfter,
): Promise<
  {
    runId: string;
    generation: number;
    sequence: number;
    payload: string;
    keyId: string | null;
    payloadSha256: string | null;
  }[]
> {
  return store.run((q) => runnerEventsAfterSteps(q, input));
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

export async function runnerResultPayload(
  store: Db,
  runId: string,
  generation: number,
): Promise<string | null> {
  return store.run((q) => runnerResultPayloadSteps(q, runId, generation));
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

export async function runnerWorkActive(store: Db, runId: string): Promise<boolean | null> {
  return store.run((q) => runnerWorkActiveSteps(q, runId));
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

export async function runnerLaneHelperWaiting(
  store: Db,
  runnerId: string,
  now: number,
): Promise<boolean> {
  return store.run((q) => runnerLaneHelperWaitingSteps(q, runnerId, now));
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

export async function runnerAgentCheckStates(store: Db, runnerId: string) {
  return store.run((q) => runnerAgentCheckStatesSteps(q, runnerId));
}

/**
 * The one probe or sign-in check the runner may be sent now, or null while another health
 * command runs, or a helper or a sign-in someone started waits. The runner keeps delivered
 * commands in arrival order and runs one at a time, so routine checks go out one by one, last.
 */
export function* nextRoutineHealthCommandSteps(q: Q, runnerId: string, now: number) {
  const { runnerCommand, runnerHealthResult } = q.t;
  if (yield* runnerLaneHelperWaitingSteps(q, runnerId, now)) return null;
  if (yield* runnerSignInWaitingSteps(q, runnerId, now)) return null;
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

export async function nextRoutineHealthCommand(
  store: Db,
  runnerId: string,
  now: number,
): Promise<number | null> {
  return store.run((q) => nextRoutineHealthCommandSteps(q, runnerId, now));
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

export async function runnerAgentOpenWorkCount(
  store: Db,
  runnerId: string,
  agent: string,
  at: number,
): Promise<number> {
  return store.run((q) => runnerAgentOpenWorkCountSteps(q, runnerId, agent, at));
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

export async function runnerHasOpenWork(store: Db, runnerId: string, at: number): Promise<boolean> {
  return store.run((q) => runnerHasOpenWorkSteps(q, runnerId, at));
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

export async function runnerAgentPolicyState(
  store: Db,
  runnerId: string,
  agent: string,
): Promise<RunnerAgentPolicyState | null> {
  return store.run((q) => runnerAgentPolicyStateSteps(q, runnerId, agent));
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

export async function setRunnerAgentSignedIn(
  store: Db,
  runnerId: string,
  agent: string,
  signedIn: boolean,
): Promise<void> {
  await store.run((q) => setRunnerAgentSignedInSteps(q, runnerId, agent, signedIn));
}

export type RunnerAssignment = {
  runId: string;
  runnerId: string;
  workspaceId: string;
  generation: number;
  runnerFence: number;
  commandId: string;
  leaseUntil: number;
  lastSequence: number;
  endedAt: number | null;
};

function assignmentColumns(w: Q["t"]["runnerWork"]) {
  return {
    runId: w.runId,
    runnerId: w.runnerId,
    workspaceId: w.workspaceId,
    generation: w.generation,
    runnerFence: w.runnerFence,
    commandId: w.commandId,
    leaseUntil: w.leaseUntil,
    lastSequence: w.lastSequence,
    endedAt: w.endedAt,
  };
}

export function* runnerWorkAssignmentSteps(q: Q, runId: string): Steps<RunnerAssignment | null> {
  const { runnerWork: w } = q.t;
  const row = yield* q.one(q.orm.select(assignmentColumns(w)).from(w).where(eq(w.runId, runId)));
  return row ?? null;
}

export async function runnerWorkAssignment(
  store: Db,
  runId: string,
): Promise<RunnerAssignment | null> {
  return store.run((q) => runnerWorkAssignmentSteps(q, runId));
}

/** The runner's assignments that have not ended. */
export function* openRunnerAssignmentsSteps(q: Q, runnerId: string): Steps<RunnerAssignment[]> {
  const { runnerWork: w } = q.t;
  return yield* q.all(
    q.orm
      .select(assignmentColumns(w))
      .from(w)
      .where(and(eq(w.runnerId, runnerId), isNull(w.endedAt))),
  );
}

export async function openRunnerAssignments(
  store: Db,
  runnerId: string,
): Promise<RunnerAssignment[]> {
  return store.run((q) => openRunnerAssignmentsSteps(q, runnerId));
}

/** Whether the runner's latest heartbeat named this run among the work it still runs. */
export function* runnerWorkStillReportedSteps(q: Q, runnerId: string, runId: string) {
  const { runner: r, runnerWork: w } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(w)
      .innerJoin(r, eq(r.id, w.runnerId))
      .where(
        and(
          eq(w.runId, runId),
          eq(r.id, runnerId),
          isNotNull(w.confirmedAt),
          isNotNull(r.liveReportedAt),
          gte(w.confirmedAt, r.liveReportedAt),
        ),
      )
      .limit(1),
  );
  return row !== undefined;
}

export async function runnerWorkStillReported(
  store: Db,
  runnerId: string,
  runId: string,
): Promise<boolean> {
  return store.run((q) => runnerWorkStillReportedSteps(q, runnerId, runId));
}

export function* runnerCommandAcknowledgedBySteps(q: Q, commandId: string, at: number) {
  const { runnerCommand: c } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(c)
      .where(and(eq(c.id, commandId), lte(c.acknowledgedAt, at)))
      .limit(1),
  );
  return row !== undefined;
}

export async function runnerCommandAcknowledgedBy(
  store: Db,
  commandId: string,
  at: number,
): Promise<boolean> {
  return store.run((q) => runnerCommandAcknowledgedBySteps(q, commandId, at));
}

/** Whether an unexpired checkpoint request is open for this run. */
export function* runnerCheckpointPendingSteps(q: Q, runId: string, now: number) {
  const { runnerCommand: c } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(c)
      .where(and(eq(c.runId, runId), eq(c.kind, "checkpoint"), gt(c.expiresAt, now)))
      .limit(1),
  );
  return row !== undefined;
}

export async function runnerCheckpointPending(
  store: Db,
  runId: string,
  now: number,
): Promise<boolean> {
  return store.run((q) => runnerCheckpointPendingSteps(q, runId, now));
}

/** Control-plane authority may outlive the signed delivery deadline after a host stall. */
export function* runnerCommandAuthorityUntilSteps(q: Q, commandId: string): Steps<number> {
  const c = q.t.runnerCommand;
  const row = yield* q.one(q.orm.select({ until: c.expiresAt }).from(c).where(eq(c.id, commandId)));
  return row?.until ?? 0;
}

export async function runnerCommandAuthorityUntil(store: Db, commandId: string): Promise<number> {
  return store.run((q) => runnerCommandAuthorityUntilSteps(q, commandId));
}

export function* runnerCommandEnvelopeSteps(q: Q, commandId: string) {
  const { runnerCommand: c } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ envelope: jsonText(q, c.envelope) })
      .from(c)
      .where(eq(c.id, commandId)),
  );
  return row?.envelope ?? null;
}

export async function runnerCommandEnvelope(store: Db, commandId: string): Promise<string | null> {
  return store.run((q) => runnerCommandEnvelopeSteps(q, commandId));
}

type NewRunnerCommand = {
  id: string;
  runnerId: string;
  runId: string | null;
  generation: number | null;
  kind: string;
  envelope: unknown;
  expiresAt: number;
};

export function* insertRunnerCommandSteps(q: Q, command: NewRunnerCommand): Steps<void> {
  yield* q.exec(
    q.orm.insert(q.t.runnerCommand).values({
      ...command,
      envelope: jsonValue(q, command.envelope),
    }),
  );
}

export async function insertRunnerCommand(store: Db, command: NewRunnerCommand): Promise<void> {
  await store.run((q) => insertRunnerCommandSteps(q, command));
}

type DeliverableRunnerCommand = {
  ordinal: number;
  envelope: string;
  runId: string | null;
  generation: number | null;
};

type CommandPage = { runnerId: string; now: number; after: number; leaseCutoff: number };

/** The next page of unacknowledged commands; work commands only while their lease holds. */
export function* deliverableRunnerCommandsSteps(
  q: Q,
  page: CommandPage,
): Steps<DeliverableRunnerCommand[]> {
  const { runnerCommand: c, runnerWork: w } = q.t;
  return yield* q.all(
    q.orm
      .select({
        ordinal: c.ordinal,
        envelope: jsonText(q, c.envelope),
        runId: c.runId,
        generation: c.generation,
      })
      .from(c)
      .leftJoin(w, eq(w.runId, c.runId))
      .where(
        and(
          eq(c.runnerId, page.runnerId),
          isNull(c.acknowledgedAt),
          gt(c.expiresAt, page.now),
          gt(c.ordinal, page.after),
          or(
            notInArray(c.kind, ["run", "review"]),
            and(
              eq(w.runnerId, c.runnerId),
              eq(w.generation, c.generation),
              isNull(w.endedAt),
              gt(w.leaseUntil, page.leaseCutoff),
            ),
          ),
        ),
      )
      .orderBy(c.ordinal)
      .limit(64),
  );
}

export async function deliverableRunnerCommands(
  store: Db,
  page: CommandPage,
): Promise<DeliverableRunnerCommand[]> {
  return store.run((q) => deliverableRunnerCommandsSteps(q, page));
}

/** Records the receipt once; the count is 0 when the runner does not own the command. */
export function* acknowledgeRunnerCommandSteps(
  q: Q,
  runnerId: string,
  commandId: string,
  now: number,
) {
  const { runnerCommand: c } = q.t;
  const rows = yield* q.all(
    q.orm
      .update(c)
      .set({ acknowledgedAt: sql`COALESCE(${c.acknowledgedAt},${now})` })
      .where(and(eq(c.id, commandId), eq(c.runnerId, runnerId)))
      .returning({ id: c.id }),
  );
  return rows.length;
}

export async function acknowledgeRunnerCommand(
  store: Db,
  runnerId: string,
  commandId: string,
  now: number,
): Promise<number> {
  return store.run((q) => acknowledgeRunnerCommandSteps(q, runnerId, commandId, now));
}

type NewAssignment = Omit<RunnerAssignment, "lastSequence" | "endedAt">;

/** Places the run on a runner: a new generation starts its sequence and confirmations over. */
export function* assignRunnerWorkSteps(q: Q, work: NewAssignment): Steps<void> {
  const { runnerWork: w } = q.t;
  const { runId: _runId, ...assigned } = work;
  yield* q.exec(
    q.orm
      .insert(w)
      .values(work)
      .onConflictDoUpdate({
        target: w.runId,
        set: {
          ...assigned,
          lastSequence: 0,
          consumedSequence: 0,
          endedAt: null,
          confirmedAt: null,
          lostAt: null,
          teardownConfirmedAt: null,
        },
      }),
  );
}

export async function assignRunnerWork(store: Db, work: NewAssignment): Promise<void> {
  await store.run((q) => assignRunnerWorkSteps(q, work));
}

/** Moves the lease forward and never back. */
export function* extendRunnerWorkLeaseSteps(q: Q, runId: string, until: number): Steps<void> {
  const { runnerWork: w } = q.t;
  const later = q.dialect === "sqlite" ? sql`MAX` : sql`GREATEST`;
  yield* q.exec(
    q.orm
      .update(w)
      .set({ leaseUntil: sql`${later}(${w.leaseUntil},${until})` })
      .where(eq(w.runId, runId)),
  );
}

export async function extendRunnerWorkLease(
  store: Db,
  runId: string,
  until: number,
): Promise<void> {
  await store.run((q) => extendRunnerWorkLeaseSteps(q, runId, until));
}

export function* endRunnerWorkSteps(q: Q, runId: string, generation: number, at: number) {
  const { runnerWork: w } = q.t;
  yield* q.exec(
    q.orm
      .update(w)
      .set({ endedAt: at })
      .where(and(eq(w.runId, runId), eq(w.generation, generation))),
  );
}

export async function endRunnerWork(
  store: Db,
  runId: string,
  generation: number,
  at: number,
): Promise<void> {
  await store.run((q) => endRunnerWorkSteps(q, runId, generation, at));
}

/** Ends work its runner no longer reports. */
export function* loseRunnerWorkSteps(q: Q, runId: string, generation: number, at: number) {
  const { runnerWork: w } = q.t;
  yield* q.exec(
    q.orm
      .update(w)
      .set({ endedAt: at, lostAt: at })
      .where(and(eq(w.runId, runId), eq(w.generation, generation))),
  );
}

export async function loseRunnerWork(
  store: Db,
  runId: string,
  generation: number,
  at: number,
): Promise<void> {
  await store.run((q) => loseRunnerWorkSteps(q, runId, generation, at));
}

/** Ends live work and confirms its teardown; the count is 0 when it already ended. */
export function* finishRunnerWorkSteps(q: Q, runId: string, generation: number, at: number) {
  const { runnerWork: w } = q.t;
  const rows = yield* q.all(
    q.orm
      .update(w)
      .set({ endedAt: at, teardownConfirmedAt: at })
      .where(and(eq(w.runId, runId), eq(w.generation, generation), isNull(w.endedAt)))
      .returning({ runId: w.runId }),
  );
  return rows.length;
}

export async function finishRunnerWork(
  store: Db,
  runId: string,
  generation: number,
  at: number,
): Promise<number> {
  return store.run((q) => finishRunnerWorkSteps(q, runId, generation, at));
}

type WorkConfirmation = { runId: string; generation: number; at: number; runnerId?: string };

export function* confirmRunnerWorkSteps(q: Q, input: WorkConfirmation): Steps<void> {
  const { runnerWork: w } = q.t;
  yield* q.exec(
    q.orm
      .update(w)
      .set({ confirmedAt: input.at })
      .where(
        and(
          eq(w.runId, input.runId),
          eq(w.generation, input.generation),
          input.runnerId === undefined ? undefined : eq(w.runnerId, input.runnerId),
        ),
      ),
  );
}

export async function confirmRunnerWork(store: Db, input: WorkConfirmation): Promise<void> {
  await store.run((q) => confirmRunnerWorkSteps(q, input));
}

type TeardownConfirmation = {
  runnerId: string;
  runId: string;
  generation: number;
  commandId: string;
  at: number;
};

/** A generation-bound confirmation from the work's own command or a cancel sent for it. */
export function* confirmRunnerWorkTeardownSteps(q: Q, input: TeardownConfirmation): Steps<void> {
  const { runnerWork: w } = q.t;
  yield* q.exec(
    q.orm
      .update(w)
      .set({ teardownConfirmedAt: sql`COALESCE(${w.teardownConfirmedAt},${input.at})` })
      .where(
        and(
          eq(w.runnerId, input.runnerId),
          eq(w.runId, input.runId),
          eq(w.generation, input.generation),
          or(
            eq(w.commandId, input.commandId),
            sql`EXISTS(SELECT 1 FROM runner_command c WHERE c.id=${input.commandId}
              AND c.runner_id=runner_work.runner_id AND c.run_id=runner_work.run_id
              AND c.generation=runner_work.generation AND c.kind='cancel')`,
          ),
        ),
      ),
  );
}

export async function confirmRunnerWorkTeardown(
  store: Db,
  input: TeardownConfirmation,
): Promise<void> {
  await store.run((q) => confirmRunnerWorkTeardownSteps(q, input));
}

const OVER_FOR_GOOD = ["merged", "completed", "cancelled", "failed"];

export function* runnerFinishedRunsSteps(q: Q, runnerId: string, limit = 64) {
  const { run, runnerWork, workItem } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ runId: runnerWork.runId })
      .from(runnerWork)
      .innerJoin(run, eq(run.id, runnerWork.runId))
      .innerJoin(workItem, eq(workItem.id, run.itemId))
      .where(
        and(
          eq(runnerWork.runnerId, runnerId),
          isNotNull(runnerWork.teardownConfirmedAt),
          inArray(workItem.state, OVER_FOR_GOOD),
        ),
      )
      .orderBy(desc(runnerWork.teardownConfirmedAt))
      .limit(limit),
  );
  return rows.map((row) => row.runId);
}

export function* setRunnerWorkLastSequenceSteps(q: Q, runId: string, sequence: number) {
  const { runnerWork: w } = q.t;
  yield* q.exec(q.orm.update(w).set({ lastSequence: sequence }).where(eq(w.runId, runId)));
}

export async function setRunnerWorkLastSequence(
  store: Db,
  runId: string,
  sequence: number,
): Promise<void> {
  await store.run((q) => setRunnerWorkLastSequenceSteps(q, runId, sequence));
}

type WorkGrant = { tokenHash: string; runId: string; generation: number; expiresAt: number };

export function* insertRunnerWorkGrantSteps(q: Q, grant: WorkGrant): Steps<void> {
  yield* q.exec(q.orm.insert(q.t.runnerWorkGrant).values(grant));
}

export async function insertRunnerWorkGrant(store: Db, grant: WorkGrant): Promise<void> {
  await store.run((q) => insertRunnerWorkGrantSteps(q, grant));
}

export function* deleteRunnerWorkGrantsSteps(q: Q, runId: string): Steps<void> {
  const { runnerWorkGrant: g } = q.t;
  yield* q.exec(q.orm.delete(g).where(eq(g.runId, runId)));
}

export async function deleteRunnerWorkGrants(store: Db, runId: string): Promise<void> {
  await store.run((q) => deleteRunnerWorkGrantsSteps(q, runId));
}

type WorkGrantKey = Omit<WorkGrant, "expiresAt">;

export function* runnerWorkGrantValidSteps(q: Q, grant: WorkGrantKey, at: number) {
  const { runnerWorkGrant: g } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(g)
      .where(
        and(
          eq(g.tokenHash, grant.tokenHash),
          eq(g.runId, grant.runId),
          eq(g.generation, grant.generation),
          gt(g.expiresAt, at),
        ),
      )
      .limit(1),
  );
  return row !== undefined;
}

/** Whether the token holds an unexpired grant for this generation of the run at `at`. */
export async function runnerWorkGrantValid(
  store: Db,
  grant: WorkGrantKey,
  at: number,
): Promise<boolean> {
  return store.run((q) => runnerWorkGrantValidSteps(q, grant, at));
}

type EventKey = { runId: string; generation: number; sequence: number };

type SealedColumns = {
  payload: string;
  keyId: string;
  payloadSha256: string;
  type: string | null;
  handedOver: number | null;
  reason: string | null;
};

export function* insertRunnerEventSteps(
  q: Q,
  key: EventKey,
  sealed: SealedColumns,
  receivedAt: number,
): Steps<void> {
  yield* q.exec(
    q.orm.insert(q.t.runnerEvent).values({
      ...key,
      ...sealed,
      payload: jsonFromText(q, sealed.payload),
      receivedAt,
    }),
  );
}

export async function insertRunnerEvent(
  store: Db,
  key: EventKey,
  sealed: SealedColumns,
  receivedAt: number,
): Promise<void> {
  await store.run((q) => insertRunnerEventSteps(q, key, sealed, receivedAt));
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

export async function branchRunnerWork(
  store: Db,
  branchName: string,
): Promise<{ runId: string; endedAt: number | null }[]> {
  return store.run((q) => branchRunnerWorkSteps(q, branchName));
}

/** Compensate authority that was live at the last responsive control-plane sample. */
export function* extendStalledRunnerWorkSteps(q: Q, startedAt: number, lagMs: number) {
  const { runnerWork: w, runnerWorkGrant: g, runnerCommand: c } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({
        runId: w.runId,
        generation: w.generation,
        leaseUntil: w.leaseUntil,
        commandId: w.commandId,
      })
      .from(w)
      .where(and(isNull(w.endedAt), gt(w.leaseUntil, runnerLeaseCutoff(startedAt)))),
  );
  for (const row of rows) {
    yield* extendRunnerWorkLeaseSteps(q, row.runId, row.leaseUntil + lagMs);
    yield* q.exec(
      q.orm
        .update(c)
        .set({ expiresAt: sql`${c.expiresAt} + ${lagMs}` })
        .where(and(eq(c.id, row.commandId), gt(c.expiresAt, startedAt))),
    );

    yield* q.exec(
      q.orm
        .update(g)
        .set({ expiresAt: sql`${g.expiresAt} + ${lagMs}` })
        .where(
          and(eq(g.runId, row.runId), eq(g.generation, row.generation), gt(g.expiresAt, startedAt)),
        ),
    );
  }
}

export function* setRunnerWorkConsumedSequenceSteps(
  q: Q,
  runId: string,
  generation: number,
  sequence: number,
) {
  const w = q.t.runnerWork;
  yield* q.exec(
    q.orm
      .update(w)
      .set({ consumedSequence: sequence })
      .where(and(eq(w.runId, runId), eq(w.generation, generation))),
  );
}

export async function setRunnerWorkConsumedSequence(
  store: Db,
  runId: string,
  generation: number,
  sequence: number,
): Promise<void> {
  await store.run((q) => setRunnerWorkConsumedSequenceSteps(q, runId, generation, sequence));
}

export function* itemSessionResultsSteps(q: Q, itemId: string) {
  const { runnerResult: result, runnerCommand: command, run } = q.t;
  return yield* q.all(
    q.orm
      .select({
        envelope: jsonText(q, command.envelope),
        payload: jsonText(q, result.payload),
        receivedAt: result.receivedAt,
      })
      .from(result)
      .innerJoin(command, eq(command.id, result.commandId))
      .innerJoin(run, eq(run.id, result.runId))
      .where(and(eq(run.itemId, itemId), eq(command.kind, "run")))
      .orderBy(desc(result.receivedAt), desc(result.generation)),
  );
}

export async function itemSessionResults(store: Db, itemId: string) {
  return store.run((q) => itemSessionResultsSteps(q, itemId));
}
export function* runPlacementCommandSteps(q: Q, runId: string) {
  const { runnerWork: work, runnerCommand: command } = q.t;
  return yield* q.one(
    q.orm
      .select({
        runnerId: work.runnerId,
        kind: command.kind,
        envelope: jsonText(q, command.envelope),
      })
      .from(work)
      .leftJoin(command, eq(command.id, work.commandId))
      .where(eq(work.runId, runId)),
  );
}

export async function runPlacementCommand(store: Db, runId: string) {
  return store.run((q) => runPlacementCommandSteps(q, runId));
}
