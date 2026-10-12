import type { ItemId } from "../core";

export type QuestionOption = string | { label?: string; value: string };

export type AskTeamInput = {
  itemId: ItemId;
  questionId?: string;
  title: string;
  body: string;
  options?: readonly QuestionOption[];
};

export type TeamAnswer = {
  questionId: string;
  answer: string;
  answeredBy: string;
};

/**
 * How a run asks a human. The quick MVP's only channel is a Linear elicitation.
 * The Linear call sits behind `TrackerAdapter`; this module owns the question record.
 */
export interface QuestionChannel {
  ask(input: AskTeamInput): Promise<{ questionId: string }>;
  deliverAnswer(input: TeamAnswer): Promise<void>;
}
