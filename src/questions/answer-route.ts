import type { Database } from "bun:sqlite";
import { auditWorkspaceAccess, getWorkItem, workspaceMember } from "../db";
import { canAnswer } from "./answerers";
import { getQuestion, type QuestionKind } from "./store";

export const QUESTION_ANSWER_PATH = "/api/questions/answer";

const MAX_ANSWER = 10_000;

const PAWS_ANSWER_KINDS = [
  "agent",
  "clarification",
  "repository",
  "runner-wait",
  "time-limit",
  "closeout-help",
  "ci-help",
  "plan-approval",
  "push-outage",
] as const;

type PawsAnswerKind = (typeof PAWS_ANSWER_KINDS)[number];

export const isPawsAnswerKind = (kind: QuestionKind): kind is PawsAnswerKind =>
  (PAWS_ANSWER_KINDS as readonly QuestionKind[]).includes(kind);

const NOT_WAITING = "This question is no longer waiting";
const REFUSED = "You cannot answer this question.";

export const pawsAnswerNote = (name: string, answer: string): string =>
  `Answered in Paws by ${name}: ${answer}`;

export type QuestionAnswer = (input: {
  questionId: string;
  answer: string;
  answeredBy: string;
  answeredByName: string;
}) => Promise<"answered" | "rejected">;

export type QuestionAnswerOptions = {
  db: Database;
  principal: { workspaceId: string; userId: string } | undefined;
  sessionIds: readonly string[] | undefined;
  submit: QuestionAnswer;
  now?: () => number;
};

export async function handleQuestionAnswer(
  request: Request,
  options: QuestionAnswerOptions,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== QUESTION_ANSWER_PATH) return null;
  const { db, principal, sessionIds } = options;
  if (principal === undefined || sessionIds === undefined)
    return Response.json({ error: "Sign in to Paws." }, { status: 401 });
  if (request.method !== "POST")
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  const body = (await request.json().catch(() => null)) as {
    questionId?: unknown;
    answer?: unknown;
  } | null;
  const answer = typeof body?.answer === "string" ? body.answer.trim() : "";
  if (
    typeof body?.questionId !== "string" ||
    typeof body.answer !== "string" ||
    answer === "" ||
    body.answer.length > MAX_ANSWER
  )
    return Response.json({ error: "Send a question and an answer." }, { status: 400 });
  const question = getQuestion(db, body.questionId);
  const item = question ? getWorkItem(db, question.itemId) : null;
  if (
    question?.status !== "open" ||
    item?.sessionKey == null ||
    !sessionIds.includes(item.sessionKey)
  )
    return Response.json({ error: NOT_WAITING }, { status: 409 });
  const kind = question.kind;
  if (!isPawsAnswerKind(kind))
    return Response.json({ error: "Answer this on the issue page" }, { status: 400 });
  const member = workspaceMember(db, principal.workspaceId, principal.userId);
  if (
    !member?.active ||
    !member.linearUserId ||
    !canAnswer({ kind }, { id: member.linearUserId })
  ) {
    auditWorkspaceAccess(db, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action: "question.refused",
      subject: `${item.linearIdentifier ?? item.id} ${kind}`,
      now: (options.now ?? Date.now)(),
    });
    return Response.json({ error: REFUSED }, { status: 403 });
  }
  const result = await options.submit({
    questionId: question.id,
    answer,
    answeredBy: member.linearUserId,
    answeredByName: member.name,
  });
  if (result === "answered") return Response.json({ ok: true });
  return Response.json({ error: NOT_WAITING }, { status: 409 });
}
