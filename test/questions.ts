import { emitJobReady, type Db } from "../src/db";
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
import { confirmDecisionSteps, suggestDecisionsSteps } from "../src/decisions";

type AskArgs = Parameters<typeof askSteps> extends [unknown, unknown, ...infer Rest] ? Rest : never;

export function askPg(db: Db, asker: QuestionAsker, ...args: AskArgs): Promise<Asked> {
  return db.transaction((q) => askSteps(q, asker, ...args));
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

export function answerQuestionPg(
  db: Db,
  id: string,
  input: Parameters<typeof answerQuestionSteps>[2],
): Promise<StoredQuestion | null> {
  return db.transaction((q) => answerQuestionSteps(q, id, input));
}

type CancelArgs =
  Parameters<typeof cancelItemQuestionsSteps> extends [unknown, ...infer Rest] ? Rest : never;

export function cancelItemQuestionsPg(db: Db, ...args: CancelArgs) {
  return db.transaction((q) => cancelItemQuestionsSteps(q, ...args));
}

export function suggestDecisionsPg(db: Db, questionId: string, text: string) {
  return db.run((q) => suggestDecisionsSteps(q, questionId, text));
}

export function confirmDecisionPg(
  db: Db,
  ...args: Parameters<typeof confirmDecisionSteps> extends [unknown, ...infer Rest] ? Rest : never
) {
  return db.transaction((q) => confirmDecisionSteps(q, ...args));
}
