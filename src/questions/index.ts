export type { AskTeamInput, QuestionChannel, QuestionOption, TeamAnswer } from "./channel";
export const pawsQuestionMarker = (questionId: string): string => `<!-- paws:q:${questionId} -->`;
export { createFakeQuestionChannel } from "./fake";
export type { FakeQuestionChannel } from "./fake";
export { elicitationBody, handoffNote } from "./note";
export {
  answerQuestion,
  findOpenQuestion,
  getQuestion,
  openQuestion,
  questionReplyConsumed,
  type StoredQuestion,
} from "./store";
