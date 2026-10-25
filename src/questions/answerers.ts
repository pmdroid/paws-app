import { canAct, type ActionActor } from "../workspace";

export type Answerer = ActionActor;

export type AnswerableQuestion =
  | { kind: "agent" }
  | { kind: "clarification" }
  | { kind: "repository" }
  | { kind: "runner-wait" }
  | { kind: "time-limit" }
  | { kind: "closeout-bypass" }
  | { kind: "ci-help" }
  | { kind: "visual-review"; delegatorId: string | null; leadId: string | null }
  | { kind: "github-auth"; actorId: string };

type Policy = {
  [K in AnswerableQuestion["kind"]]: (
    question: Extract<AnswerableQuestion, { kind: K }>,
    user: Answerer,
  ) => boolean;
};

export const answerer = (id: string): Answerer | null =>
  canAct({ id }, { kind: "answer" }).allowed ? { id } : null;

export const canAnswer = (question: AnswerableQuestion, user: Answerer): boolean =>
  canAct(user, {
    kind: "answer",
    ...(question.kind === "visual-review"
      ? { allowedIds: [question.delegatorId, question.leadId] }
      : question.kind === "github-auth"
        ? { allowedIds: [question.actorId] }
        : {}),
  }).allowed;

/** Kept for policy consumers; every entry uses the same actor and answer checks. */
export const ANSWER_POLICY: Policy = {
  agent: canAnswer,
  clarification: canAnswer,
  repository: canAnswer,
  "runner-wait": canAnswer,
  "time-limit": canAnswer,
  "closeout-bypass": canAnswer,
  "ci-help": canAnswer,
  "visual-review": canAnswer,
  "github-auth": canAnswer,
};
