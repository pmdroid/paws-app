import type { Database } from "bun:sqlite";
import { and, eq, gt, inArray, isNull, notExists, or, sql } from "drizzle-orm";
import { settled, sqliteDb, type Q, type Steps } from "./db";
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

export function runnerResultMatches(db: Database, key: RunKey, payload: string): boolean | null {
  return settled(sqliteDb(db).run((q) => runnerResultMatchesSteps(q, key, payload)));
}

type NewRunnerResult = RunKey & { commandId: string; payload: string; receivedAt: number };

export function* insertRunnerResultSteps(q: Q, row: NewRunnerResult) {
  yield* q.exec(
    q.orm.insert(q.t.runnerResult).values({ ...row, payload: jsonFromText(q, row.payload) }),
  );
}

export function insertRunnerResult(db: Database, row: NewRunnerResult): void {
  settled(sqliteDb(db).run((q) => insertRunnerResultSteps(q, row)));
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

export function runnerResultForCommand(
  db: Database,
  key: RunKey,
  commandId: string,
): string | null {
  return settled(sqliteDb(db).run((q) => runnerResultForCommandSteps(q, key, commandId)));
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

export function runnerEventPage(db: Database, key: RunKey, after: number): StoredRunnerEventRow[] {
  return settled(sqliteDb(db).run((q) => runnerEventPageSteps(q, key, after)));
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

export function storedRunnerEvent(
  db: Database,
  key: RunKey,
  sequence: number,
): StoredRunnerEventRow | null {
  return settled(sqliteDb(db).run((q) => storedRunnerEventSteps(q, key, sequence)));
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

export function storedRunnerAnswer(db: Database, key: RunKey, sequence: number): string | null {
  return settled(sqliteDb(db).run((q) => storedRunnerAnswerSteps(q, key, sequence)));
}

type NewRunnerAnswer = RunKey & { sequence: number; answer: string; createdAt: number };

export function* insertRunnerQuestionAnswerSteps(q: Q, row: NewRunnerAnswer) {
  yield* q.exec(q.orm.insert(q.t.runnerQuestionAnswer).values(row));
}

export function insertRunnerQuestionAnswer(db: Database, row: NewRunnerAnswer): void {
  settled(sqliteDb(db).run((q) => insertRunnerQuestionAnswerSteps(q, row)));
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

export function unansweredRunnerQuestions(
  db: Database,
  key: RunKey,
  types: readonly string[],
): StoredRunnerEventRow[] {
  return settled(sqliteDb(db).run((q) => unansweredRunnerQuestionsSteps(q, key, types)));
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

export function runnerQuestionAnswersAfter(
  db: Database,
  key: RunKey,
  after: number,
): { sequence: number; answer: string }[] {
  return settled(sqliteDb(db).run((q) => runnerQuestionAnswersAfterSteps(q, key, after)));
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

export function itemRunnerFollowUpTarget(
  db: Database,
  itemId: string,
  leaseCutoff: number,
): FollowUpTarget | null {
  return settled(sqliteDb(db).run((q) => itemRunnerFollowUpTargetSteps(q, itemId, leaseCutoff)));
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

export function insertRunnerFollowUp(
  db: Database,
  row: RunKey & { body: string; createdAt: number },
): void {
  settled(sqliteDb(db).run((q) => insertRunnerFollowUpSteps(q, row)));
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

export function runnerFollowUpsAfter(
  db: Database,
  key: RunKey,
  after: number,
): { sequence: number; body: string }[] {
  return settled(sqliteDb(db).run((q) => runnerFollowUpsAfterSteps(q, key, after)));
}
