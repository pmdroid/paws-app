import type { Database } from "bun:sqlite";
import { emitJobReady, sqliteDb, type Db } from "../src/db";
import {
  answerQuestionSteps,
  answerSteps,
  askSteps,
  cancelItemQuestionsSteps,
  type AnswerEffects,
  type AnswerOutcome,
  type Asked,
  type QuestionAsker,
  type QuestionReply,
  type StoredQuestion,
} from "../src/questions";
import { askSteps as loopAskSteps } from "../src/loop";
import { confirmDecisionSteps, suggestDecisionsSteps } from "../src/decisions";

type AskArgs = Parameters<typeof askSteps> extends [unknown, unknown, ...infer Rest] ? Rest : never;

export function ask(db: Database, asker: QuestionAsker, ...args: AskArgs): Promise<Asked> {
  return sqliteDb(db).transaction((q) => askSteps(q, asker, ...args));
}

export function askPg(db: Db, asker: QuestionAsker, ...args: AskArgs): Promise<Asked> {
  return db.transaction((q) => askSteps(q, asker, ...args));
}

export async function answer(
  db: Database,
  reply: QuestionReply,
  effects: AnswerEffects = {},
): Promise<AnswerOutcome> {
  const outcome = await sqliteDb(db).transaction((q) => answerSteps(q, reply, effects));
  emitJobReady(db);
  return outcome;
}

export async function answerPg(
  db: Db,
  reply: QuestionReply,
  effects: AnswerEffects = {},
): Promise<AnswerOutcome> {
  const outcome = await db.transaction((q) => answerSteps(q, reply, effects));
  emitJobReady(db);
  return outcome;
}

export function answerQuestion(
  db: Database,
  id: string,
  input: Parameters<typeof answerQuestionSteps>[2],
): Promise<StoredQuestion | null> {
  return sqliteDb(db).transaction((q) => answerQuestionSteps(q, id, input));
}

type LoopAskArgs = Parameters<typeof loopAskSteps> extends [unknown, ...infer Rest] ? Rest : never;

export function loopAsk(db: Database, ...args: LoopAskArgs) {
  return sqliteDb(db).transaction((q) => loopAskSteps(q, ...args));
}

export function cancelItemQuestions(
  db: Database,
  ...args: Parameters<typeof cancelItemQuestionsSteps> extends [unknown, ...infer Rest]
    ? Rest
    : never
) {
  return sqliteDb(db).transaction((q) => cancelItemQuestionsSteps(q, ...args));
}

export function suggestDecisions(db: Database, questionId: string, text: string) {
  return sqliteDb(db).run((q) => suggestDecisionsSteps(q, questionId, text));
}

export function confirmDecision(
  db: Database,
  ...args: Parameters<typeof confirmDecisionSteps> extends [unknown, ...infer Rest] ? Rest : never
) {
  return sqliteDb(db).transaction((q) => confirmDecisionSteps(q, ...args));
}
