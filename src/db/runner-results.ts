import { and, eq, gt, inArray, isNull, notExists, or, sql } from "drizzle-orm";
import { type Q, type Steps, type Db } from "./db";
import { jsonFromText, jsonText } from "./json-text";

export type StoredRunnerEventRow = {
  runId: string;
  generation: number;
  sequence: number;
  payload: string;
  keyId: string | null;
  payloadSha256: string | null;
};

type RunKey = { runId: string; generation: number };

function eventColumns(q: Q) {
  const { runnerEvent } = q.t;
  return {
    runId: runnerEvent.runId,
    generation: runnerEvent.generation,
    sequence: runnerEvent.sequence,
    payload: jsonText(q, runnerEvent.payload),
    keyId: runnerEvent.keyId,
    payloadSha256: runnerEvent.payloadSha256,
  };
}

export function* runnerResultMatchesSteps(
  q: Q,
  key: RunKey,
  payload: string,
): Steps<boolean | null> {
  const { runnerResult } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        same: sql<number>`CASE WHEN ${runnerResult.payload} = ${jsonFromText(q, payload)} THEN 1 ELSE 0 END`.mapWith(
          Number,
        ),
      })
      .from(runnerResult)
      .where(and(eq(runnerResult.runId, key.runId), eq(runnerResult.generation, key.generation))),
  );
  return row === undefined ? null : row.same === 1;
}

export async function runnerResultMatches(
  store: Db,
  key: RunKey,
  payload: string,
): Promise<boolean | null> {
  return store.run((q) => runnerResultMatchesSteps(q, key, payload));
}

type NewRunnerResult = RunKey & { commandId: string; payload: string; receivedAt: number };

export function* insertRunnerResultSteps(q: Q, row: NewRunnerResult) {
  yield* q.exec(
    q.orm.insert(q.t.runnerResult).values({ ...row, payload: jsonFromText(q, row.payload) }),
  );
}

export async function insertRunnerResult(store: Db, row: NewRunnerResult): Promise<void> {
  await store.run((q) => insertRunnerResultSteps(q, row));
}

export function* runnerResultForCommandSteps(
  q: Q,
  key: RunKey,
  commandId: string,
): Steps<string | null> {
  const { runnerResult } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ payload: jsonText(q, runnerResult.payload) })
      .from(runnerResult)
      .where(
        and(
          eq(runnerResult.runId, key.runId),
          eq(runnerResult.generation, key.generation),
          eq(runnerResult.commandId, commandId),
        ),
      ),
  );
  return row?.payload ?? null;
}

export async function runnerResultForCommand(
  store: Db,
  key: RunKey,
  commandId: string,
): Promise<string | null> {
  return store.run((q) => runnerResultForCommandSteps(q, key, commandId));
}

export function* runnerEventPageSteps(
  q: Q,
  key: RunKey,
  after: number,
): Steps<StoredRunnerEventRow[]> {
  const { runnerEvent } = q.t;
  return yield* q.all(
    q.orm
      .select(eventColumns(q))
      .from(runnerEvent)
      .where(
        and(
          eq(runnerEvent.runId, key.runId),
          eq(runnerEvent.generation, key.generation),
          gt(runnerEvent.sequence, after),
        ),
      )
      .orderBy(runnerEvent.sequence)
      .limit(64),
  );
}

export async function runnerEventPage(
  store: Db,
  key: RunKey,
  after: number,
): Promise<StoredRunnerEventRow[]> {
  return store.run((q) => runnerEventPageSteps(q, key, after));
}

export function* storedRunnerEventSteps(
  q: Q,
  key: RunKey,
  sequence: number,
): Steps<StoredRunnerEventRow | null> {
  const { runnerEvent } = q.t;
  const row = yield* q.one(
    q.orm
      .select(eventColumns(q))
      .from(runnerEvent)
      .where(
        and(
          eq(runnerEvent.runId, key.runId),
          eq(runnerEvent.generation, key.generation),
          eq(runnerEvent.sequence, sequence),
        ),
      ),
  );
  return row ?? null;
}

export async function storedRunnerEvent(
  store: Db,
  key: RunKey,
  sequence: number,
): Promise<StoredRunnerEventRow | null> {
  return store.run((q) => storedRunnerEventSteps(q, key, sequence));
}

export function* storedRunnerAnswerSteps(
  q: Q,
  key: RunKey,
  sequence: number,
): Steps<string | null> {
  const { runnerQuestionAnswer: answer } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ answer: answer.answer })
      .from(answer)
      .where(
        and(
          eq(answer.runId, key.runId),
          eq(answer.generation, key.generation),
          eq(answer.sequence, sequence),
        ),
      ),
  );
  return row?.answer ?? null;
}

export async function storedRunnerAnswer(
  store: Db,
  key: RunKey,
  sequence: number,
): Promise<string | null> {
  return store.run((q) => storedRunnerAnswerSteps(q, key, sequence));
}

type NewRunnerAnswer = RunKey & { sequence: number; answer: string; createdAt: number };

export function* insertRunnerQuestionAnswerSteps(q: Q, row: NewRunnerAnswer) {
  yield* q.exec(q.orm.insert(q.t.runnerQuestionAnswer).values(row));
}

export async function insertRunnerQuestionAnswer(store: Db, row: NewRunnerAnswer): Promise<void> {
  await store.run((q) => insertRunnerQuestionAnswerSteps(q, row));
}

export function* unansweredRunnerQuestionsSteps(
  q: Q,
  key: RunKey,
  types: readonly string[],
): Steps<StoredRunnerEventRow[]> {
  const { runnerEvent, runnerQuestionAnswer: answer } = q.t;
  return yield* q.all(
    q.orm
      .select(eventColumns(q))
      .from(runnerEvent)
      .where(
        and(
          eq(runnerEvent.runId, key.runId),
          eq(runnerEvent.generation, key.generation),
          or(
            inArray(runnerEvent.type, [...types]),
            and(isNull(runnerEvent.type), isNull(runnerEvent.keyId)),
          ),
          notExists(
            q.orm
              .select({ one: sql`1` })
              .from(answer)
              .where(
                and(
                  eq(answer.runId, runnerEvent.runId),
                  eq(answer.generation, runnerEvent.generation),
                  eq(answer.sequence, runnerEvent.sequence),
                ),
              ),
          ),
        ),
      )
      .orderBy(runnerEvent.sequence),
  );
}

export async function unansweredRunnerQuestions(
  store: Db,
  key: RunKey,
  types: readonly string[],
): Promise<StoredRunnerEventRow[]> {
  return store.run((q) => unansweredRunnerQuestionsSteps(q, key, types));
}

export function* runnerQuestionAnswersAfterSteps(
  q: Q,
  key: RunKey,
  after: number,
): Steps<{ sequence: number; answer: string }[]> {
  const { runnerQuestionAnswer: answer } = q.t;
  return yield* q.all(
    q.orm
      .select({ sequence: answer.sequence, answer: answer.answer })
      .from(answer)
      .where(
        and(
          eq(answer.runId, key.runId),
          eq(answer.generation, key.generation),
          gt(answer.sequence, after),
        ),
      )
      .orderBy(answer.sequence)
      .limit(64),
  );
}

export async function runnerQuestionAnswersAfter(
  store: Db,
  key: RunKey,
  after: number,
): Promise<{ sequence: number; answer: string }[]> {
  return store.run((q) => runnerQuestionAnswersAfterSteps(q, key, after));
}

type FollowUpTarget = { runId: string; generation: number; version: string | null };

export function* itemRunnerFollowUpTargetSteps(
  q: Q,
  itemId: string,
  leaseCutoff: number,
): Steps<FollowUpTarget | null> {
  const { runnerHostStatus, runnerWork, workItem } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        runId: runnerWork.runId,
        generation: runnerWork.generation,
        version: runnerHostStatus.runnerVersion,
      })
      .from(workItem)
      .innerJoin(runnerWork, eq(runnerWork.runId, workItem.currentRunId))
      .innerJoin(runnerHostStatus, eq(runnerHostStatus.runnerId, runnerWork.runnerId))
      .where(
        and(
          eq(workItem.id, itemId),
          isNull(runnerWork.endedAt),
          gt(runnerWork.leaseUntil, leaseCutoff),
        ),
      ),
  );
  return row ?? null;
}

export async function itemRunnerFollowUpTarget(
  store: Db,
  itemId: string,
  leaseCutoff: number,
): Promise<FollowUpTarget | null> {
  return store.run((q) => itemRunnerFollowUpTargetSteps(q, itemId, leaseCutoff));
}

export function* insertRunnerFollowUpSteps(
  q: Q,
  row: RunKey & { body: string; createdAt: number },
) {
  const { runnerFollowUp } = q.t;
  const next = yield* q.one(
    q.orm
      .select({
        sequence: sql<number>`COALESCE(MAX(${runnerFollowUp.sequence}),0)+1`.mapWith(Number),
      })
      .from(runnerFollowUp)
      .where(
        and(eq(runnerFollowUp.runId, row.runId), eq(runnerFollowUp.generation, row.generation)),
      ),
  );
  yield* q.exec(q.orm.insert(runnerFollowUp).values({ ...row, sequence: next!.sequence }));
}

export async function insertRunnerFollowUp(
  store: Db,
  row: RunKey & { body: string; createdAt: number },
): Promise<void> {
  await store.run((q) => insertRunnerFollowUpSteps(q, row));
}

export function* runnerFollowUpsAfterSteps(
  q: Q,
  key: RunKey,
  after: number,
): Steps<{ sequence: number; body: string }[]> {
  const { runnerFollowUp } = q.t;
  return yield* q.all(
    q.orm
      .select({ sequence: runnerFollowUp.sequence, body: runnerFollowUp.body })
      .from(runnerFollowUp)
      .where(
        and(
          eq(runnerFollowUp.runId, key.runId),
          eq(runnerFollowUp.generation, key.generation),
          gt(runnerFollowUp.sequence, after),
        ),
      )
      .orderBy(runnerFollowUp.sequence)
      .limit(64),
  );
}

export async function runnerFollowUpsAfter(
  store: Db,
  key: RunKey,
  after: number,
): Promise<{ sequence: number; body: string }[]> {
  return store.run((q) => runnerFollowUpsAfterSteps(q, key, after));
}

/** Runner events still stored as plaintext, after `after` in key order. */
export function* plaintextRunnerEventsSteps(
  q: Q,
  after: readonly [runId: string, generation: number, sequence: number],
  limit: number,
): Steps<StoredRunnerEventRow[]> {
  const { runnerEvent: e } = q.t;
  const [runId, generation, sequence] = after;
  return yield* q.all(
    q.orm
      .select(eventColumns(q))
      .from(e)
      .where(
        and(
          sql`(${e.runId}, ${e.generation}, ${e.sequence}) > (${runId}, ${generation}, ${sequence})`,
          isNull(e.keyId),
        ),
      )
      .orderBy(e.runId, e.generation, e.sequence)
      .limit(limit),
  );
}

type SealedRunnerEvent = {
  payload: string;
  keyId: string;
  payloadSha256: string;
  type: string | null;
  handedOver: number | null;
  reason: string | null;
};

/** Replaces a plaintext event's payload with its sealed columns, unless it is sealed already. */
export function* sealRunnerEventSteps(
  q: Q,
  key: RunKey & { sequence: number },
  sealed: SealedRunnerEvent,
): Steps<void> {
  const { runnerEvent: e } = q.t;
  yield* q.exec(
    q.orm
      .update(e)
      .set({ ...sealed, payload: jsonFromText(q, sealed.payload) })
      .where(
        and(
          eq(e.runId, key.runId),
          eq(e.generation, key.generation),
          eq(e.sequence, key.sequence),
          isNull(e.keyId),
        ),
      ),
  );
}

/**
 * Deletes up to `limit` events of runs that ended before `cutoff`, keeping the questions and
 * artifacts nobody answered, and returns how many it deleted.
 */
export function* pruneRunnerEventsSteps(q: Q, cutoff: number, limit: number): Steps<number> {
  const { runnerEvent: e } = q.t;
  const prunableRuns = sql`
    SELECT r.id FROM run r
    WHERE r.status IN ('ended','lost') AND r.updated_at<${cutoff}
      AND NOT EXISTS(SELECT 1 FROM work_item i WHERE i.current_run_id=r.id
        AND i.state NOT IN ('merged','completed','cancelled'))
      AND NOT EXISTS(SELECT 1 FROM runner_work w WHERE w.run_id=r.id AND w.ended_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM runner_event q
        WHERE q.run_id=r.id
          AND (q.type IN ('question','artifact','closeout_policy','ci_rerun') OR (q.type IS NULL AND q.key_id IS NULL))
          AND NOT EXISTS(SELECT 1 FROM runner_question_answer a
            WHERE a.run_id=q.run_id AND a.generation=q.generation AND a.sequence=q.sequence))`;
  const prunable = sql`
    SELECT e.run_id, e.generation, e.sequence FROM runner_event e
    WHERE e.run_id IN (${prunableRuns})
      AND NOT EXISTS(SELECT 1 FROM runner_question_answer a
        WHERE a.run_id=e.run_id AND a.generation=e.generation AND a.sequence=e.sequence)
    LIMIT ${limit}`;
  const deleted = yield* q.all(
    q.orm
      .delete(e)
      .where(sql`(${e.runId}, ${e.generation}, ${e.sequence}) IN (${prunable})`)
      .returning({ sequence: e.sequence }),
  );
  return deleted.length;
}
