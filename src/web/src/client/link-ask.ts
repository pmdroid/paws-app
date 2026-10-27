import type {
  LinkAskKind,
  StatusBypassAsk,
  StatusQuestion,
  StatusReviewRounds,
  StatusRiskAsk,
} from "../contract";
import { esc } from "./format";

/** The Needs you button for each kind. */
export const LINK_ASK_ACTIONS: Record<LinkAskKind, string> = {
  bypass: "Review bypass",
  screenshots: "Review screenshots",
  risk: "Review risk",
  question: "Answer question",
  rounds: "Answer question",
};

/** The card's id on the item page; Linear links to `/status/issues/<id>#<anchor>`. */
export const LINK_ASK_ANCHORS: Record<LinkAskKind, string> = {
  bypass: "closeout",
  screenshots: "visual-review",
  risk: "risk",
  question: "question",
  rounds: "review-rounds",
};

const HEADINGS: Record<LinkAskKind, string> = {
  bypass: "Closeout bypass",
  screenshots: "Visual review",
  risk: "Risk",
  question: "Question",
  rounds: "Review rounds",
};

const NOTE_LABELS: Record<LinkAskKind, string> = {
  bypass: "Reason for the bypass, or guidance for the agent",
  screenshots: "What to change",
  risk: "Note, or what to change",
  question: "Your answer",
  rounds: "Note for the agent (optional)",
};

/** What a reply in Linear does for each kind, under the card. */
const LINEAR_REPLY: Record<LinkAskKind, string> = {
  bypass: "A reply in Linear only sends the agent guidance.",
  screenshots: "A reply in Linear only sends the agent guidance.",
  risk: "A reply in Linear only requests changes and never approves.",
  question: "A reply in Linear only sends the agent guidance.",
  rounds: "A reply in Linear counts as Rethink the approach, with the reply as the note.",
};

const APPROVE: Record<Exclude<LinkAskKind, "question" | "rounds">, string> = {
  bypass: "Bypass",
  screenshots: "Accept screens",
  risk: "Approve",
};

export const LINK_ASK_ANSWERERS =
  "Only the person who delegated this issue or the Linear project's lead can decide.";

const drafts = new Map<string, string>();
const selections = new Map<string, Set<string>>();
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
  if (ask.kind === "bypass" && ask.bypass) return bypassCard(question, ask.bypass);
  if (ask.kind === "risk" && ask.risk) return riskCard(question, ask.risk);
  const id = question.id;
  const busy = pending.has(id);
  const disabled = busy ? ' disabled=""' : "";
  const buttons =
    ask.kind === "question"
      ? `<button class="btn primary" type="submit" name="decision" value="answer"${disabled}>Send answer</button>`
      : ask.kind === "rounds"
        ? `<button class="btn primary" type="submit" name="decision" value="rethink"${disabled}>Rethink the approach</button><button class="btn" type="submit" name="decision" value="continue"${disabled}>Keep going</button><button class="btn" type="submit" name="decision" value="stop"${disabled}>Stop</button>`
        : `<button class="btn primary" type="submit" name="decision" value="approve"${disabled}>${APPROVE[ask.kind]}</button><button class="btn" type="submit" name="decision" value="changes"${disabled}>${ask.kind === "bypass" ? "Send guidance" : "Request changes"}</button>`;
  return `<section id="${LINK_ASK_ANCHORS[ask.kind]}" class="closeout-result blocked link-ask" aria-labelledby="link-ask-${esc(id)}"><div class="min-w-0"><h2 id="link-ask-${esc(id)}">${HEADINGS[ask.kind]}</h2><p><b>${esc(ask.title)}</b></p>${ask.detail ? `<p>${esc(ask.detail)}</p>` : ""}${ask.rounds ? reviewRounds(ask.rounds) : ""}<p class="muted">Commit <span class="mono">${esc(ask.head.slice(0, 7))}</span>. ${LINK_ASK_ANSWERERS} ${LINEAR_REPLY[ask.kind]}</p><form class="link-ask-form" data-link-ask="${esc(id)}"><label class="field"><span>${NOTE_LABELS[ask.kind]}</span><textarea name="note" rows="3" maxlength="10000">${esc(drafts.get(id) ?? "")}</textarea></label><div class="row wrap">${buttons}</div><p class="muted" role="status">${esc(messages.get(id) ?? "")}</p></form></div></section>`;
}

/** Each round with its commit and finding count, the findings still open, and what each choice does. */
function reviewRounds(rounds: StatusReviewRounds): string {
  const list = rounds.rounds
    .map(
      (round, index) =>
        `<li>Round ${index + 1}: <span class="mono">${esc(round.head.slice(0, 7))}</span>, ${round.findings} ${round.findings === 1 ? "finding" : "findings"}</li>`,
    )
    .join("");
  const open = rounds.open
    .map(
      (finding) =>
        `<li><b>${esc(finding.severity)}</b> <span class="mono">${esc(finding.location)}</span>: ${esc(finding.bugClass)}</li>`,
    )
    .join("");
  const more = rounds.limit === null ? "more rounds" : `${rounds.limit} more rounds`;
  return `<h3>Rounds</h3><ol class="review-rounds">${list}</ol>${open ? `<h3>Still open</h3><ul class="review-open">${open}</ul>` : ""}<p class="muted"><b>Rethink the approach</b> restarts the agent with these findings and your note. <b>Keep going</b> allows ${esc(more)}. <b>Stop</b> ends the work; the branch keeps it.</p>`;
}

/** "Bypass 2 checks for 7f65200 and re-verify". */
export function bypassLabel(count: number, head: string): string {
  return `Bypass ${count} ${count === 1 ? "check" : "checks"} for ${head.slice(0, 7)} and re-verify`;
}

const STATE_LABELS: Record<string, string> = {
  failed: "Failed",
  exhausted: "Out of attempts",
  independence: "Needs another model",
};

/**
 * "Closeout needs your help": each failed check with its state, attempt and
 * finding, a checkbox and a required reason; bypass the selected checks for
 * this head and re-verify, send guidance instead, or stop.
 */
function bypassCard(question: StatusQuestion, bypass: StatusBypassAsk): string {
  const ask = question.linkAsk!;
  const id = question.id;
  const busy = pending.has(id) ? ' disabled=""' : "";
  const head = ask.head.slice(0, 7);
  const chosen = selectedChecks(id, bypass);
  const checks = bypass.checks
    .map((check) => {
      const field = `${id}:${check.id}`;
      const attempt = check.attempt === null ? "" : `attempt ${check.attempt}`;
      const meta = [attempt, check.kind].filter(Boolean).join(" · ");
      return `<div class="bypass-check"><label><input type="checkbox" name="check" value="${esc(check.id)}"${chosen.has(check.id) ? ' checked=""' : ""}${busy}> <b>${esc(check.id)}</b> <span class="tag failed">${esc(STATE_LABELS[check.state] ?? check.state)}</span>${meta ? ` <span class="mono muted">${esc(meta)}</span>` : ""}</label>${check.finding ? `<div class="bypass-finding">${esc(check.finding)}</div>` : ""}<label class="field"><span>Why bypass ${esc(check.id)}?</span><span class="muted">Required when selected. Saved with your name in Audit history and in the pull request body.</span><textarea name="reason" data-check="${esc(check.id)}" rows="2" maxlength="10000">${esc(drafts.get(field) ?? "")}</textarea></label></div>`;
    })
    .join("");
  const passed = bypass.passed.length
    ? `<p class="row wrap"><span class="tag passed">Passed</span> <span>${esc(bypass.passed.join(", "))}</span></p>`
    : "";
  return `<section id="closeout" class="card link-ask" aria-labelledby="link-ask-${esc(id)}"><div class="min-w-0"><div class="row wrap"><span class="tag now">Needs you</span><h2 id="link-ask-${esc(id)}">Closeout needs your help</h2></div>${ask.detail ? `<p>${esc(ask.detail)}</p>` : ""}<form class="link-ask-form" data-link-ask="${esc(id)}" data-bypass="${esc(ask.head)}">${checks}${passed}<label class="field"><span>Guidance for the agent instead</span><textarea name="note" rows="2" maxlength="10000">${esc(drafts.get(id) ?? "")}</textarea></label><p class="muted">${LINK_ASK_ANSWERERS} A reply in Linear never bypasses a check.</p><div class="row wrap"><button class="btn primary" type="submit" name="decision" value="approve" data-bypass-submit=""${busy || (chosen.size === 0 ? ' disabled=""' : "")}>${esc(bypassLabel(chosen.size, ask.head))}</button><button class="btn" type="submit" name="decision" value="changes"${busy}>Send guidance instead</button><details><summary class="btn">Stop</summary><p>Stop this item and keep its branch?</p><button class="btn" type="button" data-link-ask-stop="${esc(question.itemId)}"${busy}>Confirm stop</button></details></div><p class="muted">The bypass covers commit <span class="mono">${esc(head)}</span> and policy <span class="mono">${esc(shortDigest(bypass.policyDigest))}</span> only. A new commit runs every check again.</p><p class="muted" role="status">${esc(messages.get(id) ?? "")}</p></form></div></section>`;
}

/** "Approve 7f65200". */
export function riskApproveLabel(head: string): string {
  return `Approve ${head.slice(0, 7)}`;
}

/**
 * The Risk card: the high-risk paths the head changes, Closeout's summary and the review
 * findings; approve the head, request changes with a note, or stop with the pull request open.
 */
function riskCard(question: StatusQuestion, risk: StatusRiskAsk): string {
  const ask = question.linkAsk!;
  const id = question.id;
  const busy = pending.has(id) ? ' disabled=""' : "";
  const head = ask.head.slice(0, 7);
  const paths = risk.paths.length
    ? `<p>High-risk paths changed:</p><ul class="risk-paths">${risk.paths.map((path) => `<li class="mono">${esc(path)}</li>`).join("")}</ul>`
    : ask.detail
      ? `<p>${esc(ask.detail)}</p>`
      : "";
  const summary = risk.summary.trim() ? `<h3>Closeout</h3><p>${esc(risk.summary.trim())}</p>` : "";
  const findings = risk.findings.length
    ? `<h3>Review findings</h3>${risk.findings.map((entry) => `<div class="bypass-finding"><b>${esc(entry.id)}</b> ${esc(entry.finding)}</div>`).join("")}`
    : "";
  return `<section id="risk" class="card link-ask" aria-labelledby="link-ask-${esc(id)}"><div class="min-w-0"><div class="row wrap"><span class="tag now">Needs you</span><h2 id="link-ask-${esc(id)}">Risk</h2></div><p><b>${esc(ask.title)}</b></p>${paths}${summary}${findings}<form class="link-ask-form" data-link-ask="${esc(id)}"><label class="field"><span>${NOTE_LABELS.risk}</span><span class="muted">Required to request changes; the agent gets it.</span><textarea name="note" rows="3" maxlength="10000">${esc(drafts.get(id) ?? "")}</textarea></label><p class="muted">${LINK_ASK_ANSWERERS} A reply in Linear only requests changes and never approves.</p><div class="row wrap"><button class="btn primary" type="submit" name="decision" value="approve"${busy}>${esc(riskApproveLabel(ask.head))}</button><button class="btn" type="submit" name="decision" value="changes"${busy}>Request changes</button><details><summary class="btn">Stop</summary><p>Stop this item? The pull request stays open.</p><button class="btn" type="submit" name="decision" value="stop"${busy}>Confirm stop</button></details></div><p class="muted">The approval covers commit <span class="mono">${esc(head)}</span>. A new commit asks again, unless it only rebased onto main with the same patch.</p><p class="muted" role="status">${esc(messages.get(id) ?? "")}</p></form></div></section>`;
}

function shortDigest(digest: string): string {
  return digest ? digest.replace(/^(sha256:[0-9a-f]{7})[0-9a-f]*$/, "$1") : "unavailable";
}

/** What a person ticked; a single failed check starts ticked. */
function selectedChecks(questionId: string, bypass: StatusBypassAsk): Set<string> {
  const chosen = selections.get(questionId);
  if (chosen) return chosen;
  return new Set(bypass.checks.length === 1 ? [bypass.checks[0]!.id] : []);
}

/** Keeps which checks a person ticked across repaints. */
export function setBypassSelection(questionId: string, checks: readonly string[]): void {
  selections.set(questionId, new Set(checks));
}

/** Keeps the reason a person typed for one check across repaints. */
export function setBypassReason(questionId: string, checkId: string, reason: string | null): void {
  if (reason === null) drafts.delete(`${questionId}:${checkId}`);
  else drafts.set(`${questionId}:${checkId}`, reason);
}

/** Keeps what a person typed across repaints. */
export function setLinkAskDraft(questionId: string, note: string | null): void {
  if (note === null) {
    drafts.delete(questionId);
    selections.delete(questionId);
    for (const key of [...drafts.keys()]) if (key.startsWith(`${questionId}:`)) drafts.delete(key);
  } else drafts.set(questionId, note);
}

/** The status line under the form; `pending` disables its buttons. */
export function setLinkAskStatus(questionId: string, message: string, busy: boolean): void {
  messages.set(questionId, message);
  if (busy) pending.add(questionId);
  else pending.delete(questionId);
}

export function linkAskDraft(questionId: string): string {
  return drafts.get(questionId) ?? "";
}

export function linkAskMessage(questionId: string): string {
  return messages.get(questionId) ?? "";
}

export function linkAskPending(questionId: string): boolean {
  return pending.has(questionId);
}
