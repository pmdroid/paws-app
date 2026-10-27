import type { Database } from "bun:sqlite";
import {
  auditWorkspaceAccess,
  getLinkAsk,
  getWorkItem,
  LINK_ASK_DECISIONS,
  LINK_ASK_NOTE_REQUIRED,
  workspaceMember,
  type LinkAskDecision,
} from "../db";

/**
 * `POST /api/link-asks` with `{ questionId, decision, note }`: a decision made on the item page.
 * A bypass approval sends `bypasses: [{ checkId, reason }]` instead of a note.
 */
export const LINK_ASK_ANSWER_PATH = "/api/link-asks";

const MAX_NOTE = 10_000;
const MAX_BYPASSES = 100;

const DECISIONS = new Set<LinkAskDecision>(Object.values(LINK_ASK_DECISIONS).flat());

export const LINK_ASK_ANSWERERS =
  "Only the person who delegated this issue or the Linear project's lead can decide this.";

export type LinkAskAnswer = (input: {
  questionId: string;
  decision: LinkAskDecision;
  note: string | null;
  /** The checks a bypass approval bypasses, each with its reason. */
  bypasses?: { checkId: string; reason: string }[];
  /** Linear user id of the signed-in person. */
  answeredBy: string;
  /** The Paws account for the Audit history row. */
  actor: { workspaceId: string; userId: string; name: string };
}) => Promise<"answered" | "forbidden" | "rejected">;

export type LinkAskAnswerOptions = {
  db: Database;
  principal: { workspaceId: string; userId: string } | undefined;
  /** Sessions the signed-in person can see. */
  sessionIds: readonly string[] | undefined;
  submit: LinkAskAnswer;
  now?: () => number;
};

/**
 * Answers a link ask for a signed-in person. The server already checked the
 * origin and the CSRF token; `submit` checks who may decide.
 */
export async function handleLinkAskAnswer(
  request: Request,
  options: LinkAskAnswerOptions,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== LINK_ASK_ANSWER_PATH) return null;
  const { db, principal, sessionIds } = options;
  if (principal === undefined || sessionIds === undefined)
    return Response.json({ error: "Sign in to Paws." }, { status: 401 });
  if (request.method !== "POST")
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  const body = (await request.json().catch(() => null)) as {
    questionId?: unknown;
    decision?: unknown;
    note?: unknown;
    bypasses?: unknown;
  } | null;
  const note = body?.note ?? "";
  if (
    typeof body?.questionId !== "string" ||
    typeof body.decision !== "string" ||
    !DECISIONS.has(body.decision as LinkAskDecision) ||
    typeof note !== "string" ||
    note.length > MAX_NOTE
  )
    return Response.json({ error: "Send a question, a decision and a note." }, { status: 400 });
  const decision = body.decision as LinkAskDecision;
  const ask = getLinkAsk(db, body.questionId);
  const item = ask ? getWorkItem(db, ask.itemId) : null;
  if (
    !ask ||
    ask.closedAt !== null ||
    item?.sessionKey == null ||
    !sessionIds.includes(item.sessionKey)
  )
    return Response.json(
      { error: "This decision is no longer waiting. Refresh the issue." },
      { status: 409 },
    );
  if (!LINK_ASK_DECISIONS[ask.kind].includes(decision))
    return Response.json({ error: "That decision does not fit this question." }, { status: 400 });
  const bypassing = ask.kind === "bypass" && decision === "approve";
  const bypasses = bypassing ? readBypasses(body.bypasses) : undefined;
  if (bypasses === null)
    return Response.json(
      { error: "Select a failed check and write why it may be bypassed." },
      { status: 400 },
    );
  if (LINK_ASK_NOTE_REQUIRED.has(decision) && note.trim() === "")
    return Response.json(
      { error: decision === "answer" ? "Write your answer." : "Write what to change." },
      { status: 400 },
    );
  // A rule break is approved with a reason, which is recorded with the approver.
  if (ask.kind === "rule" && note.trim() === "")
    return Response.json({ error: "Write why the rule may break." }, { status: 400 });
  const member = workspaceMember(db, principal.workspaceId, principal.userId);
  const refuse = () => {
    auditWorkspaceAccess(db, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action: "decision.refused",
      subject: `${item.linearIdentifier ?? item.id} ${ask.headCommit.slice(0, 7)} ${ask.kind}`,
      now: (options.now ?? Date.now)(),
    });
    return Response.json({ error: LINK_ASK_ANSWERERS }, { status: 403 });
  };
  if (!member?.active || member.role === "observer" || !member.linearUserId) return refuse();
  const result = await options.submit({
    questionId: ask.questionId,
    decision,
    note: note.trim() || null,
    ...(bypasses ? { bypasses } : {}),
    answeredBy: member.linearUserId,
    actor: { workspaceId: principal.workspaceId, userId: principal.userId, name: member.name },
  });
  if (result === "answered") return Response.json({ ok: true });
  if (result === "forbidden") return refuse();
  return Response.json(
    { error: "This decision is no longer waiting. Refresh the issue." },
    { status: 409 },
  );
}

/** At least one `{ checkId, reason }`, each check once, each with a reason. Null otherwise. */
function readBypasses(input: unknown): { checkId: string; reason: string }[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_BYPASSES) return null;
  const bypasses: { checkId: string; reason: string }[] = [];
  for (const entry of input as unknown[]) {
    if (typeof entry !== "object" || entry === null) return null;
    const { checkId, reason } = entry as { checkId?: unknown; reason?: unknown };
    if (
      typeof checkId !== "string" ||
      typeof reason !== "string" ||
      checkId.trim() === "" ||
      reason.trim() === "" ||
      reason.length > MAX_NOTE ||
      bypasses.some((bypass) => bypass.checkId === checkId)
    )
      return null;
    bypasses.push({ checkId, reason: reason.trim() });
  }
  return bypasses;
}
