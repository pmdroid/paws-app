import type {
  LinkAskKind,
  QuestionCard,
  QuestionDetailResponse,
  QuestionListResponse,
} from "../contract";
import { ago, avatar, esc, linkList } from "./format";
import { LINK_ASK_ACTIONS, LINK_ASK_ANCHORS } from "./link-ask";
import { PAGES } from "./navigation";
import {
  questionAnswerDraft,
  questionAnswerLocked,
  questionAnswerMessage,
} from "./question-answer";
import { routeHref } from "./route";

/** The header badge for each link ask kind; the same headings as its decision card on the issue page. */
const KIND_BADGES: Record<LinkAskKind, string> = {
  bypass: "Closeout bypass",
  screenshots: "Visual review",
  risk: "Risk",
  question: "Question",
  rounds: "Review rounds",
  rule: "Rule break",
};

const EMPTY =
  "No open questions. Paws asks here when the agent or Closeout needs a person, such as a spent fix budget or a bypass.";

export interface QuestionsView {
  selected: string | null;
  list: QuestionListResponse | null;
  detail: QuestionDetailResponse | null;
  missing: boolean;
  error: string | null;
}

export function renderQuestions(view: QuestionsView): string {
  const heading = `<h1 class="sr-only">${PAGES.questions.title}</h1>`;
  if (view.selected === null) {
    if (view.list === null) return `${heading}${pending(view.error)}`;
    const list = view.list;
    const cards = list.questions
      .map((question) => questionCard(question, list.generatedAt, false))
      .join("");
    if (!cards) return `${heading}<div class="empty">${EMPTY}</div>`;
    return `${heading}${cards}<p class="muted">Oldest first. An answered question leaves this list.</p>`;
  }
  const back = `<p><a href="${routeHref({ view: "questions", id: null })}">All questions</a></p>`;
  if (view.missing)
    return `${heading}${back}<div class="empty" role="status">This question is answered, or it is not in your sessions.</div>`;
  if (view.detail === null) return `${heading}${back}${pending(view.error)}`;
  return `${heading}${back}${questionCard(view.detail.question, view.detail.generatedAt, true)}`;
}

function pending(error: string | null): string {
  if (error !== null)
    return `<div class="empty"><div>Questions unavailable</div>${esc(error)}<div><button class="btn primary" type="button" data-action="refresh">Retry</button></div></div>`;
  return '<div class="empty" role="status">Loading questions…</div>';
}

function questionCard(question: QuestionCard, generatedAt: string, highlight: boolean): string {
  const disabled = questionAnswerLocked(question.id) ? ' disabled=""' : "";
  const options = question.options
    .map((option, index) => {
      const selected = index === question.recommendedOption ? " sel" : "";
      const rec =
        index === question.recommendedOption
          ? '<span class="rec tag lin">agent recommends</span>'
          : "";
      return question.answerable
        ? `<button class="opt btn${selected}" type="submit" name="option" value="${esc(option)}"${disabled}><span class="mono dim">${index + 1}</span>${esc(option)}${rec}</button>`
        : `<div class="opt static${selected}"><span class="mono dim">${index + 1}</span>${esc(option)}${rec}</div>`;
    })
    .join("");
  const claimed = question.claimedBy
    ? `${avatar(question.claimedBy, true)}<span>${esc(question.claimedBy)} claimed</span>`
    : "<span>unclaimed</span>";
  const issueHref = routeHref({ view: "issues", id: question.issue.id });
  const decide = question.linkAsk
    ? `<a class="btn primary" href="${issueHref}#${LINK_ASK_ANCHORS[question.linkAsk.kind]}">${LINK_ASK_ACTIONS[question.linkAsk.kind]}</a>`
    : "";
  const links = question.links.length ? linkList(question.links) : "";
  const note = question.answerable
    ? '<span class="dim">Answering here also posts your answer in Linear.</span>'
    : decide || links
      ? ""
      : '<span class="dim">Answer in the source conversation to continue.</span>';
  const badge = question.linkAsk ? KIND_BADGES[question.linkAsk.kind] : "Question";
  return `<article class="q${highlight ? " hl" : ""}" id="q-${esc(question.id)}">
    <div class="qh">
      <div class="row wrap min-w-0"><span class="st awaiting_input">${badge}</span><a class="lin-id" href="${issueHref}">${esc(question.issue.id)}</a><span class="min-w-0">${esc(question.issue.title)}</span></div>
      <span class="mono dim">${esc(question.issue.agent)} · ${esc(ago(question.askedAt, generatedAt))}</span>
    </div>
    <div class="qb"><div class="row wrap min-w-0"><b>${esc(question.title)}</b><span class="tag${question.kind === "exhausted" ? " bad" : ""}">${esc(question.kind)}</span><span class="tag">${esc(question.urgency)}</span></div>
      <div class="claim">${claimed}</div><div class="muted">${esc(question.body)}</div>
      ${question.context ? `<div class="ctx">${esc(question.context)}</div>` : ""}
      ${question.answerable ? questionAnswerForm(question, options, disabled) : options ? `<div class="opts">${options}</div>` : ""}
      <div class="row">${decide}${links}${note}</div>
    </div></article>`;
}

function questionAnswerForm(question: QuestionCard, options: string, disabled: string): string {
  const id = esc(question.id);
  return `<form class="question-answer" data-question-answer="${id}">${options ? `<div class="opts">${options}</div>` : ""}<label class="field"><span>Or write an answer</span><textarea name="answer" rows="3" maxlength="10000"${disabled}>${esc(questionAnswerDraft(question.id))}</textarea></label><div class="row wrap"><button class="btn primary" type="submit"${disabled}>Answer</button></div><p class="muted" role="status">${esc(questionAnswerMessage(question.id))}</p></form>`;
}
