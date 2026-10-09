export type { AskTeamInput, QuestionChannel, TeamAnswer } from "./channel";
export const pawsQuestionMarker = (questionId: string): string => `<!-- paws:q:${questionId} -->`;
export { createFakeQuestionChannel } from "./fake";
export type { FakeQuestionChannel } from "./fake";
export { elicitationBody, handoffNote } from "./note";
export {
  answerQuestion,
  findOpenQuestion,
  getQuestion,
  openQuestion,
  type StoredQuestion,
} from "./store";
