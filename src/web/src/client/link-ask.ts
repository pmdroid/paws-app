import type { LinkAskKind, StatusQuestion } from "../contract";
import { esc } from "./format";

/** The Needs you button for each kind. */
export const LINK_ASK_ACTIONS: Record<LinkAskKind, string> = {
  bypass: "Review bypass",
  screenshots: "Review screenshots",
  risk: "Review risk",
  question: "Answer question",
};

/** The card's id on the item page; Linear links to `/status/issues/<id>#<anchor>`. */
export const LINK_ASK_ANCHORS: Record<LinkAskKind, string> = {
  bypass: "closeout",
  screenshots: "visual-review",
  risk: "risk",
  question: "question",
};

const HEADINGS: Record<LinkAskKind, string> = {
  bypass: "Closeout bypass",
  screenshots: "Visual review",
  risk: "Risk",
  question: "Question",
};

const NOTE_LABELS: Record<LinkAskKind, string> = {
  bypass: "Reason for the bypass, or guidance for the agent",
  screenshots: "What to change",
  risk: "Note, or what to change",
  question: "Your answer",
};

const APPROVE: Record<Exclude<LinkAskKind, "question">, string> = {
  bypass: "Bypass",
  screenshots: "Accept screens",
  risk: "Approve",
};

export const LINK_ASK_ANSWERERS =
  "Only the person who delegated this issue or the Linear project's lead can decide.";

const drafts = new Map<string, string>();
const messages = new Map<string, string>();
const pending = new Set<string>();

/** Whether a hash names a link ask card, such as `#risk`. */
export function linkAskAnchor(hash: string): boolean {
  return Object.values(LINK_ASK_ANCHORS).includes(hash.replace(/^#/, ""));
}

/** The card a link ask opens on the item page: what to decide, the commit, and the form. */
export function linkAskCard(question: StatusQuestion): string {
  const ask = question.linkAsk;
  if (!ask) return "";
  const id = question.id;
  const busy = pending.has(id);
  const buttons =
    ask.kind === "question"
      ? `<button class="btn primary" type="submit" name="decision" value="answer"${busy ? ' disabled=""' : ""}>Send answer</button>`
      : `<button class="btn primary" type="submit" name="decision" value="approve"${busy ? ' disabled=""' : ""}>${APPROVE[ask.kind]}</button><button class="btn" type="submit" name="decision" value="changes"${busy ? ' disabled=""' : ""}>${ask.kind === "bypass" ? "Send guidance" : "Request changes"}</button>`;
  return `<section id="${LINK_ASK_ANCHORS[ask.kind]}" class="closeout-result blocked link-ask" aria-labelledby="link-ask-${esc(id)}"><div class="min-w-0"><h2 id="link-ask-${esc(id)}">${HEADINGS[ask.kind]}</h2><p><b>${esc(ask.title)}</b></p>${ask.detail ? `<p>${esc(ask.detail)}</p>` : ""}<p class="muted">Commit <span class="mono">${esc(ask.head.slice(0, 7))}</span>. ${LINK_ASK_ANSWERERS} A reply in Linear only sends the agent guidance.</p><form class="link-ask-form" data-link-ask="${esc(id)}"><label class="field"><span>${NOTE_LABELS[ask.kind]}</span><textarea name="note" rows="3" maxlength="10000">${esc(drafts.get(id) ?? "")}</textarea></label><div class="row wrap">${buttons}</div><p class="muted" role="status">${esc(messages.get(id) ?? "")}</p></form></div></section>`;
}

/** Keeps what a person typed across repaints. */
export function setLinkAskDraft(questionId: string, note: string | null): void {
  if (note === null) drafts.delete(questionId);
  else drafts.set(questionId, note);
}

/** The status line under the form; `pending` disables its buttons. */
export function setLinkAskStatus(questionId: string, message: string, busy: boolean): void {
  messages.set(questionId, message);
  if (busy) pending.add(questionId);
  else pending.delete(questionId);
}

export function linkAskPending(questionId: string): boolean {
  return pending.has(questionId);
}
