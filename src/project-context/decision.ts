import {
  contextSourceRestriction,
  currentSourceContextRecords,
  type ContextNamespace,
  type Db,
} from "../db";
import { canSee, requesterAccess, type ContextAccess } from "./policy";
import { contextKey, sanitizedContextText } from "./sanitize";
import { recordWorkItemContext } from "./session";
import { CONTEXT_CLAIM_LIMITS, correctContext } from "./store";

const DECISION_TEXT_CHARS = 300;

export type AnsweredDecision = {
  readonly organizationId: string;
  readonly projectId: string | null;
  readonly workItemId: string;
  readonly issueIdentifier: string;
  readonly url?: string | null;
  readonly questionId: string;
  readonly question: string;
  readonly answer: string;
  readonly answererId: string;
  readonly answererName: string;
  readonly now: number;
};

export type AnsweredDecisionOutcome = "stored" | "corrected" | "unchanged" | "outside_project";

export async function recordAnsweredDecision(
  db: Db,
  access: ContextAccess,
  input: AnsweredDecision,
): Promise<AnsweredDecisionOutcome> {
  if (!input.projectId) return "outside_project";
  const namespace: ContextNamespace = {
    workspaceId: input.organizationId,
    scopeKind: "linear_project",
    scopeId: input.projectId,
  };
  const requester = { workspaceId: input.organizationId, userId: input.answererId };
  const project = await contextSourceRestriction(db, namespace, {
    kind: "linear_project_description",
    id: input.projectId,
  });
  const current = project?.status === "active" ? await requesterAccess(access, requester) : null;
  if (!project || !current || !canSee(current, project.restriction))
    throw new Error(`project context refused the decision from ${input.answererId}`);
  const fullQuestion = input.question.trim();
  const question = fullQuestion.slice(0, DECISION_TEXT_CHARS);
  const body = `${question} → ${input.answer.trim().slice(0, DECISION_TEXT_CHARS)}`;
  const reason = `Answered by ${input.answererName} on ${input.issueIdentifier}`;
  const bytes = CONTEXT_CLAIM_LIMITS.bytes.observation;
  const stored = sanitizedContextText(`${body} Reason: ${reason}`, bytes);
  const asked = sanitizedContextText(`${question} →`, bytes);
  const rows = await currentSourceContextRecords(
    db,
    namespace,
    { kind: "paws_work_item", id: input.workItemId },
    input.now,
  );
  const key = contextKey("decision", fullQuestion);
  const earlier =
    rows.find((row) => row.classification === "decision" && row.recordKey === key) ??
    (fullQuestion.length < DECISION_TEXT_CHARS
      ? rows.find(
          (row) =>
            row.classification === "decision" &&
            !row.recordKey.startsWith("decision:") &&
            row.body.startsWith(`${asked} `),
        )
      : undefined);
  if (earlier?.body === stored) return "unchanged";
  if (earlier) {
    const corrected = await correctContext(db, access, {
      namespace,
      requester,
      recordId: earlier.id,
      body: stored,
      now: input.now,
    });
    if (corrected.status !== "corrected")
      throw new Error(`project context refused the correction: ${corrected.status}`);
    return "corrected";
  }
  const outcome = await recordWorkItemContext(db, access, {
    namespace,
    requester,
    workItemId: input.workItemId,
    url: input.url ?? null,
    revision: `answer-${input.questionId}`,
    revisionAt: input.now,
    restriction: project.restriction,
    kept: rows,
    entries: [{ classification: "decision", body, reason, key }],
    now: input.now,
  });
  if (outcome.status !== "stored")
    throw new Error(`project context did not store the decision: ${outcome.status}`);
  return "stored";
}
