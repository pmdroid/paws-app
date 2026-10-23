export type Answerer = { id: string };

export type AnswerableQuestion =
  | { kind: "agent" }
  | { kind: "clarification" }
  | { kind: "repository" }
  | { kind: "runner-wait" }
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
  agent: () => true,
  clarification: () => true,
  repository: () => true,
  "runner-wait": () => true,
  "closeout-bypass": () => true,
  "visual-review": (question, user) =>
    user.id === question.delegatorId || user.id === question.leadId,
  "github-auth": (question, user) => user.id === question.actorId,
};

export const answerer = (id: string): Answerer | null =>
  id === "unknown" || id === "linear" || !id.trim() ? null : { id };

export const canAnswer = (question: AnswerableQuestion, user: Answerer): boolean =>
  answerer(user.id) !== null &&
  (ANSWER_POLICY[question.kind] as (question: AnswerableQuestion, user: Answerer) => boolean)(
    question,
    user,
  );
