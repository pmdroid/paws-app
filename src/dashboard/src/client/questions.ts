import type { QuestionCard, QuestionDetailResponse, QuestionListResponse } from "../contract";
import { agentChip, ago, avatar, esc, linkList } from "./format";
import { LINK_ASK_ACTIONS, LINK_ASK_ANCHORS } from "./link-ask";
import { PAGES } from "./navigation";
import { routeHref } from "./route";

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
    return `${heading}${cards || '<div class="empty">No open questions.</div>'}`;
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
  const options = question.options
    .map((option, index) => {
      const selected = index === question.recommendedOption ? " sel" : "";
      const rec =
        index === question.recommendedOption
          ? '<span class="rec tag lin">agent recommends</span>'
          : "";
      return `<div class="opt static${selected}"><span class="mono dim">${index + 1}</span>${esc(option)}${rec}</div>`;
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
  return `<article class="q${highlight ? " hl" : ""}" id="q-${esc(question.id)}">
    <div class="qh">
      <div class="row wrap min-w-0"><span class="lin-id">${esc(question.id)}</span><span class="tag${question.kind === "exhausted" ? " bad" : ""}">${esc(question.kind)}</span><span class="tag">${esc(question.urgency)}</span><a class="lin-id" href="${issueHref}" title="${esc(question.issue.title)}">${esc(question.issue.id)}</a>${agentChip(question.issue.agent)}</div>
      <div class="claim">${claimed}<span class="dim">${esc(ago(question.askedAt, generatedAt))}</span></div>
      <div class="title min-w-0">${esc(question.title)}</div>
    </div>
    <div class="qb"><div class="muted">${esc(question.body)}</div>
      ${question.context ? `<div class="ctx">${esc(question.context)}</div>` : ""}
      ${options ? `<div class="opts">${options}</div>` : ""}
      <div class="row">${decide || links ? `${decide}${links}` : '<span class="dim">Answer in the source conversation to continue.</span>'}</div>
    </div></article>`;
}
