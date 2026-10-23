export type Answerer = { id: string };

export type AnswerableQuestion =
  | { kind: "agent" }
  | { kind: "closeout-bypass" }
  | { kind: "visual-review"; delegatorId: string | null; leadId: string | null }
  | { kind: "github-auth"; actorId: string };

type Policy = {
  [K in AnswerableQuestion["kind"]]: (
    question: Extract<AnswerableQuestion, { kind: K }>,
    user: Answerer,
  ) => boolean;
};

export const ANSWER_POLICY: Policy = {
  agent: () => false,
  "closeout-bypass": () => false,
  "visual-review": () => false,
  "github-auth": () => false,
};

export const answerer = (_id: string): Answerer | null => null;

export const canAnswer = (_question: AnswerableQuestion, _user: Answerer): boolean => false;
