import { Database } from "bun:sqlite";
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

const store = (db: Database | Db): Db => (db instanceof Database ? sqliteDb(db) : db);

type AskArgs = Parameters<typeof askSteps> extends [unknown, unknown, ...infer Rest] ? Rest : never;

export function ask(db: Database | Db, asker: QuestionAsker, ...args: AskArgs): Promise<Asked> {
  return store(db).transaction((q) => askSteps(q, asker, ...args));
}

export async function answer(
  db: Database | Db,
  reply: QuestionReply,
  effects: AnswerEffects = {},
): Promise<AnswerOutcome> {
  const outcome = await store(db).transaction((q) => answerSteps(q, reply, effects));
  emitJobReady(db);
  return outcome;
}

export function answerQuestion(
  db: Database | Db,
  id: string,
  input: Parameters<typeof answerQuestionSteps>[2],
): Promise<StoredQuestion | null> {
  return store(db).transaction((q) => answerQuestionSteps(q, id, input));
}

type LoopAskArgs = Parameters<typeof loopAskSteps> extends [unknown, ...infer Rest] ? Rest : never;

export function loopAsk(db: Database | Db, ...args: LoopAskArgs) {
  return store(db).transaction((q) => loopAskSteps(q, ...args));
}

export function cancelItemQuestions(
  db: Database | Db,
  ...args: Parameters<typeof cancelItemQuestionsSteps> extends [unknown, ...infer Rest]
    ? Rest
    : never
) {
  return store(db).transaction((q) => cancelItemQuestionsSteps(q, ...args));
}

export function suggestDecisions(db: Database | Db, questionId: string, text: string) {
  return store(db).run((q) => suggestDecisionsSteps(q, questionId, text));
}

export function confirmDecision(
  db: Database | Db,
  ...args: Parameters<typeof confirmDecisionSteps> extends [unknown, ...infer Rest] ? Rest : never
) {
  return store(db).transaction((q) => confirmDecisionSteps(q, ...args));
}
