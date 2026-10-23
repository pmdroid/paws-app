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
export {
  getVisualReview,
  openVisualReview,
  reviewedEvidenceIds,
  visualReviewBody,
  VISUAL_REVIEW_ANSWERERS,
  VISUAL_REVIEW_OPTIONS,
  VISUAL_REVIEW_QUESTION,
  VISUAL_REVIEW_REMINDER,
  VISUAL_REVIEW_REMINDER_MS,
  VISUAL_REVIEW_WAIT,
  type StoredVisualReview,
} from "./visual-review";
