import type { Database } from "bun:sqlite";
import { emitJobReady, sqliteDb } from "../src/db";
import {
  answerQuestionSteps,
  answerSteps,
  askSteps,
  type AnswerEffects,
  type AnswerOutcome,
  type Asked,
  type QuestionAsker,
  type QuestionReply,
  type StoredQuestion,
} from "../src/questions";

type AskArgs = Parameters<typeof askSteps> extends [unknown, unknown, ...infer Rest] ? Rest : never;

export function ask(db: Database, asker: QuestionAsker, ...args: AskArgs): Promise<Asked> {
  return sqliteDb(db).transaction((q) => askSteps(q, asker, ...args));
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

export function answerQuestion(
  db: Database,
  id: string,
  input: Parameters<typeof answerQuestionSteps>[2],
): Promise<StoredQuestion | null> {
  return sqliteDb(db).transaction((q) => answerQuestionSteps(q, id, input));
}
