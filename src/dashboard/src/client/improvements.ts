import {
  IMPROVEMENT_LIFECYCLES,
  improvementQuery,
  type AttentionState,
  type ImprovementAttention,
  type ImprovementDetail,
  type ImprovementFilter,
  type ImprovementFollowThroughDetail,
  type ImprovementItem,
  type ImprovementLifecycle,
  type ImprovementList,
  type RetroHistory,
  type RetroReportResponse,
  type RetroSchedule,
} from "../improvements";
import type { FindingGroupRun } from "../../../db";
import { esc, safeHref } from "./format";
import { routeHref, type ImprovementTab } from "./route";

export type DecisionChoice = "create" | "link" | "reject";

export type ImprovementsView = {
  tab: ImprovementTab;
  id: string | null;
  filter: ImprovementFilter;
  list: ImprovementList | null;
  listError: string | null;
  attention: ImprovementAttention | null;
  detail: ImprovementDetail | null;
  follow: ImprovementFollowThroughDetail | null;
  detailState: "idle" | "loading" | "ready" | "missing" | "forbidden" | "error";
  detailError: string | null;
  schedule: RetroSchedule | null;
  daily: { enabled: boolean; lastRun: FindingGroupRun | null } | null;
  report: RetroReportResponse | null;
  reportState: "loading" | "ready" | "missing" | "error";
  history: RetroHistory | null;
  historyError: string | null;
  expanded: boolean;
  choice: DecisionChoice | null;
  drafts: Record<string, string>;
  confirmClosed: string | null;
  busy: string | null;
  message: string;
  error: string | null;
  local: boolean;
  now: number;
};

const SOURCE_LABEL = { daily_finding: "Daily finding", retro_item: "Weekly retro" } as const;

const LIFECYCLE_LABEL: Record<ImprovementLifecycle, string> = {
  needs_review: "Needs review",
  pending: "Accepted · filing",
  linked: "Linked",
  rejected: "Rejected",
};

const ATTENTION_LABEL: Record<AttentionState, string> = {
  needs_review: "Needs review",
  rejected: "Rejected",
  accepted_unfiled: "Accepted · filing",
  filing_failed: "Filing needs you",
  ready_to_delegate: "Ready to delegate",
  working: "Working",
  blocked: "Blocked",
  awaiting_verification: "Merged · awaiting verification",
  verified: "Verified",
  verification_stale: "Verification contradicted",
  canceled: "Canceled",
  unavailable: "Issue unavailable",
  stale_sync: "Sync stale",
  closed: "Closed without a fix",
};

const ATTENTION_TONE: Partial<Record<AttentionState, string>> = {
  filing_failed: "err",
  blocked: "err",
  verification_stale: "err",
  verified: "done",
  awaiting_verification: "warn",
  accepted_unfiled: "warn",
  stale_sync: "warn",
  unavailable: "warn",
  working: "now",
};

const NEXT_ACTION: Record<AttentionState, string> = {
  needs_review: "Review it: create an issue, link an existing one, or reject it.",
  rejected: "Rejected. It stays in history and nothing was filed.",
  accepted_unfiled: "Accepted. Paws is filing it in Linear.",
  filing_failed: "Accepted. Filing needs you: retry it or choose a recovery.",
  ready_to_delegate: "Filed. Delegate it to Paws when you want the work done.",
  working: "Paws is working on the issue.",
  blocked: "The work is blocked. Open the issue, or choose a recovery.",
  awaiting_verification:
    "Merged. Record evidence for the verification criterion; a merge alone does not prove the fix.",
  verified: "Verified with evidence.",
  verification_stale: "New evidence contradicts the verification. Review it.",
  canceled: "The work was canceled. Choose a recovery.",
  unavailable: "Paws cannot read the Linear issue now. Choose a recovery or wait.",
  stale_sync: "Paws has not read the Linear issue for 6 hours. It keeps trying.",
  closed: "Closed without a fix.",
};

const DELIVERY_LABEL = {
  create_issue: "Create issue",
  link_issue: "Link issue",
  evidence_comment: "Evidence comment",
} as const;

const BLOCK_LABEL: Record<string, string> = {
  destination: "the team is no longer mapped to this repository",
  unauthorized: "Linear access was revoked",
  unavailable: "Linear cannot find the issue",
  conflict: "the issue changed in Linear",
  attempts: "eight attempts did not get an answer",
  workspace: "this workspace has no Linear connection",
};

const IMPLEMENTATION_LABEL: Record<string, string> = {
  unknown: "Not known yet",
  not_started: "Not started",
  in_progress: "In progress",
  blocked: "Blocked",
  merged: "Merged",
  completed: "Completed",
  canceled: "Canceled",
  stale: "Stale",
};

const VERIFICATION_LABEL: Record<string, string> = {
  unknown: "Not due",
  due: "Due",
  verified: "Verified",
  contradicted: "Contradicted",
};

const RECOVERY_LABEL = {
  acknowledge: "Close without a fix",
  redelegate: "Delegate again",
  return_to_review: "Return to review",
} as const;

const GENERATION_LABEL: Record<string, string> = {
  queued: "Queued",
  waiting_for_runner: "Waiting for a runner",
  generating: "Generating",
  failed: "Failed",
  ready: "Ready",
};

export function utcTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "";
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function period(start: number, end: number): string {
  return `${day(start)} to ${day(end)}`;
}

const tag = (label: string, tone = "") =>
  `<span class="tag wrap${tone ? ` ${tone}` : ""}">${esc(label)}</span>`;

const attentionTag = (state: AttentionState) =>
  tag(ATTENTION_LABEL[state], ATTENTION_TONE[state] ?? "");

function attentionOf(view: ImprovementsView, item: ImprovementItem): AttentionState | null {
  if (view.follow?.followThrough.id === item.id) return view.follow.followThrough.attention;
  return view.attention?.items.find((entry) => entry.id === item.id)?.attention ?? null;
}

function listHref(filter: ImprovementFilter): string {
  return `${routeHref({ view: "improvements", tab: "review", id: null })}${improvementQuery(filter)}`;
}

function itemHref(id: string, filter: ImprovementFilter): string {
  return `${routeHref({ view: "improvements", tab: "review", id })}${improvementQuery(filter)}`;
}

function issueLink(issue: { identifier: string | null; url: string | null; id?: string | null }) {
  const label = esc(issue.identifier ?? issue.id ?? "Linear issue");
  const href = issue.url ? safeHref(issue.url) : null;
  return href
    ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer"><span class="lin-id">${label}</span></a>`
    : `<span class="lin-id">${label}</span>`;
}

function disabled(view: ImprovementsView): string {
  return view.busy !== null || !view.local ? " disabled" : "";
}

export function renderImprovements(view: ImprovementsView): string {
  const tabs = renderTabs(view);
  const status = `<p class="muted" role="status" data-improvements-message="">${esc(view.message)}</p>`;
  const alert = view.error ? `<p class="checkout-error" role="alert">${esc(view.error)}</p>` : "";
  const body =
    view.tab === "history"
      ? renderHistory(view)
      : view.tab === "settings"
        ? renderSettings(view)
        : view.tab === "report"
          ? renderReport(view)
          : renderReview(view);
  return `${tabs}${alert}${status}${body}`;
}

function renderTabs(view: ImprovementsView): string {
  const tab = (target: ImprovementTab, label: string, count?: number) => {
    const current =
      target === view.tab || (target === "review" && view.tab === "report") ? "page" : null;
    const href =
      target === "review"
        ? listHref(view.filter)
        : routeHref({ view: "improvements", tab: target, id: null });
    const badge = count && count > 0 ? ` <b aria-label="${count} need attention">${count}</b>` : "";
    return `<a class="btn${current ? " on" : ""}" href="${esc(href)}"${current ? ' aria-current="page"' : ""}>${esc(label)}${badge}</a>`;
  };
  return `<nav class="row" aria-label="Improvement pages">${tab("review", "Review", view.attention?.counts.total)}${tab("history", "History")}${tab("settings", "Settings")}</nav>`;
}

function renderSources(view: ImprovementsView): string {
  const daily = view.daily;
  const dailyLine =
    daily === null
      ? "Loading the last grouping run…"
      : !daily.enabled
        ? "Daily grouping is off. Findings still arrive one by one."
        : daily.lastRun === null
          ? "No grouping run yet."
          : daily.lastRun.status === "failed"
            ? `The last grouping run failed ${utcTime(daily.lastRun.startedAt)}: ${daily.lastRun.error ?? "no detail"}.`
            : daily.lastRun.status === "running"
              ? `Grouping since ${utcTime(daily.lastRun.startedAt)}.`
              : `Last grouped ${utcTime(daily.lastRun.finishedAt ?? daily.lastRun.startedAt)} into ${daily.lastRun.groupCount} group${daily.lastRun.groupCount === 1 ? "" : "s"}.`;
  return `<section class="card improvement-sources" aria-label="Sources">
    <div class="improvement-source"><div class="row">${tag("Daily findings")}<span>${esc(dailyLine)}</span></div><a href="${esc(routeHref({ view: "findings" }))}">Findings and groups</a></div>
    <div class="improvement-source">${weeklySource(view)}</div>
  </section>`;
}

function weeklySource(view: ImprovementsView): string {
  const schedule = view.schedule;
  if (schedule === null)
    return `<div class="row">${tag("Weekly retros")}<span>Loading the retro schedule…</span></div>`;
  const run = `<button class="btn" type="button" data-improvement-action="run-retro"${disabled(view)}>Run retro</button>`;
  const current = schedule.current;
  const generation = current?.generation ?? null;
  const report = (retroId: string, label: string) =>
    `<a href="${esc(routeHref({ view: "improvements", tab: "report", id: retroId }))}">${esc(label)}</a>`;
  if (schedule.lastSuccess === null && current === null)
    return `<div class="row">${tag("Weekly retros")}<span>${esc(schedule.reason ?? "No retro has run yet.")}</span></div><div class="row"><span>Your first retro reads every recorded session in the selected repositories.</span>${schedule.canRun ? run : ""}</div>`;
  if (schedule.state === "failed")
    return `<div class="row">${tag("Weekly retros")}${tag("Generation failed", "err")}<span>${esc(schedule.reason ?? "The retro could not be generated.")}</span></div><div class="row">${schedule.retry ? `<span>Paws retries ${esc(utcTime(schedule.retry.at))}.</span>` : ""}${schedule.canRun ? `<button class="btn primary" type="button" data-improvement-action="run-retro"${disabled(view)}>Retry generation</button>` : ""}${current ? report(current.retroId, "Open this retro") : ""}</div>`;
  if (schedule.state === "waiting" || schedule.state === "generating") {
    const label =
      schedule.state === "generating"
        ? "Generating"
        : generation?.state === "waiting_for_runner"
          ? "Waiting for a runner"
          : "Queued";
    const runners =
      generation?.state === "waiting_for_runner"
        ? `<a href="${esc(routeHref({ view: "runners", id: null }))}">Check runners</a>`
        : "";
    return `<div class="row">${tag("Weekly retros")}${tag(label, schedule.state === "generating" ? "now" : "warn")}<span>${esc(schedule.reason ?? "")}</span></div><div class="row">${current ? `<span>${esc(period(current.windowStart, current.windowEnd))}.</span>${report(current.retroId, "Open this retro")}` : ""}${runners}</div>`;
  }
  const last = schedule.lastSuccess;
  const next = schedule.nextRun ? ` Next run ${utcTime(schedule.nextRun.at)}.` : "";
  if (schedule.state === "empty" && last)
    return `<div class="row">${tag("Weekly retros")}<span>No recurring patterns in ${esc(period(last.windowStart, last.cutoff))}.${esc(next)}</span></div><div class="row">${report(last.retroId, "Open the report")}${schedule.canRun ? run : ""}</div>`;
  return `<div class="row">${tag("Weekly retros")}<span>${last ? `Last published ${esc(utcTime(last.publishedAt))} for ${esc(period(last.windowStart, last.cutoff))}.` : ""}${esc(next)}</span></div><div class="row">${last ? report(last.retroId, "Open the report") : ""}${schedule.canRun ? run : ""}</div>`;
}

function renderFilters(view: ImprovementsView): string {
  const option = (value: string, label: string, selected: string) =>
    `<option value="${esc(value)}"${value === selected ? " selected" : ""}>${esc(label)}</option>`;
  const repositories = view.list?.repositories ?? [];
  const shown =
    view.filter.repository && !repositories.includes(view.filter.repository)
      ? [...repositories, view.filter.repository]
      : repositories;
  return `<form class="settings-controls improvement-filters" role="search" aria-label="Filter improvements" data-improvement-filters="">
    <label class="field"><span>Source</span><select name="source" data-improvement-filter="source">${option("", "All sources", view.filter.source)}${option("daily", "Daily findings", view.filter.source)}${option("weekly", "Weekly retros", view.filter.source)}</select></label>
    <label class="field"><span>Repository</span><select name="repository" data-improvement-filter="repository">${option("", "Any repository", view.filter.repository)}${shown.map((repository) => option(repository, repository, view.filter.repository)).join("")}</select></label>
    <label class="field"><span>State</span><select name="state" data-improvement-filter="state">${option("", "Any state", view.filter.state)}${IMPROVEMENT_LIFECYCLES.map((state) => option(state, LIFECYCLE_LABEL[state], view.filter.state)).join("")}</select></label>
  </form>`;
}

function renderReview(view: ImprovementsView): string {
  const counts = view.list?.counts;
  const summary = counts
    ? `<p class="muted">${counts.needsReview} to review · ${counts.daily} from daily findings · ${counts.weekly} from weekly retros · ${counts.linked} linked</p>`
    : "";
  const open = view.id !== null;
  const lists = `${renderSources(view)}${renderFilters(view)}${summary}`;
  return `${open ? `<div class="flex min-w-0 flex-col gap-6 max-md:hidden">${lists}</div>` : lists}<div class="improvements-layout" data-open="${open}">
    <section class="improvement-list-pane${open ? " max-md:hidden" : ""}" aria-label="Improvements" data-scroll-key="list">${renderList(view)}</section>
    <section class="improvement-detail-pane${open ? "" : " max-md:hidden"}" aria-label="Selected improvement" aria-busy="${view.detailState === "loading"}">${renderDetail(view)}</section>
  </div>`;
}

function emptyList(view: ImprovementsView): string {
  const filtered = view.filter.source || view.filter.repository || view.filter.state;
  if (filtered)
    return `No improvements match these filters. <a href="${esc(listHref({ source: "", repository: "", state: "" }))}">Clear filters</a>`;
  return "Nothing to review yet. Daily findings and weekly retro patterns arrive here.";
}

function renderList(view: ImprovementsView): string {
  if (view.list === null)
    return view.listError
      ? `<div class="empty" role="status"><div>Improvements unavailable</div>${esc(view.listError)}<div><button class="btn primary" type="button" data-improvement-action="reload">Retry</button></div></div>`
      : `<div class="empty" role="status">Loading improvements…</div>`;
  const { items } = view.list;
  const rows = items.length
    ? `<ul class="improvement-rows" role="list">${items.map((item) => row(view, item)).join("")}</ul>`
    : `<div class="empty" role="status">${emptyList(view)}</div>`;
  const more = view.list.nextCursor
    ? `<button class="btn" type="button" data-improvement-action="more"${view.busy === "more" ? " disabled" : ""}>Show more (${items.length} of ${view.list.matching})</button>`
    : "";
  const stale = view.listError
    ? `<p class="checkout-error" role="alert">${esc(view.listError)} Showing the last list Paws read.</p>`
    : "";
  return `${stale}${rows}${more}`;
}

function row(view: ImprovementsView, item: ImprovementItem): string {
  const selected = item.id === view.id;
  const attention = attentionOf(view, item);
  const state = attention ? attentionTag(attention) : tag(LIFECYCLE_LABEL[item.lifecycle]);
  const issue = item.issue?.identifier ? tag(item.issue.identifier) : "";
  return `<li><a class="improvement-row" href="${esc(itemHref(item.id, view.filter))}" data-improvement-row="${esc(item.id)}"${selected ? ' aria-current="true"' : ""}>
    <span class="row">${tag(SOURCE_LABEL[item.sourceKind])}<span class="muted">${esc(item.repository)}</span></span>
    <span class="improvement-row-title">${esc(item.proposal.title)}</span>
    <span class="row">${state}${issue}</span>
  </a></li>`;
}

function renderDetail(view: ImprovementsView): string {
  const back = `<a class="btn md:hidden" href="${esc(listHref(view.filter))}" data-improvement-back="">All improvements</a>`;
  if (view.id === null)
    return `<div class="empty" role="status">Select an improvement to see its evidence, proposed change and next action.</div>`;
  if (view.detailState === "missing" || view.detailState === "forbidden")
    return `${back}<div class="empty" role="status"><div>${view.detailState === "forbidden" ? "Workspace access changed" : "Not in your inbox"}</div>${
      view.detailState === "forbidden"
        ? "Paws no longer lets you read this improvement. Nothing about it changed; ask a workspace admin if you need access."
        : "This improvement is not in your inbox. You may have lost access to its repository or sessions."
    }</div>`;
  const detail = view.detail?.item.id === view.id ? view.detail : null;
  if (detail === null)
    return view.detailState === "error"
      ? `${back}<div class="empty" role="status"><div>Improvement unavailable</div>${esc(view.detailError ?? "")}<div><button class="btn primary" type="button" data-improvement-action="reload">Retry</button></div></div>`
      : `${back}<div class="empty" role="status">Loading the improvement…</div>`;
  const item = detail.item;
  const follow = view.follow?.followThrough.id === item.id ? view.follow : null;
  const attention = attentionOf(view, item);
  const stale = view.detailError
    ? `<p class="checkout-error" role="alert">${esc(view.detailError)} Showing what Paws read last.</p>`
    : "";
  return `${back}${stale}<article class="improvement-detail" data-improvement="${esc(item.id)}">
    <div class="row">${tag(SOURCE_LABEL[item.sourceKind])}${tag(item.proposal.actionStep)}<span class="muted">${esc(item.repository)}</span>${attention ? attentionTag(attention) : ""}</div>
    <h2 id="improvement-heading" tabindex="-1">${esc(item.proposal.title)}</h2>
    <p class="muted">${esc(attention ? NEXT_ACTION[attention] : LIFECYCLE_LABEL[item.lifecycle])}</p>
    <section class="improvement-part" aria-labelledby="improvement-problem"><h3 id="improvement-problem">Problem</h3><p>${esc(item.proposal.problem)}</p></section>
    ${renderEvidence(view, detail)}
    <section class="improvement-part" aria-labelledby="improvement-change"><h3 id="improvement-change">Intended change</h3><p>${esc(item.proposal.proposedChange)}</p></section>
    <section class="improvement-part" aria-labelledby="improvement-criterion"><h3 id="improvement-criterion">Verification criterion</h3><p>${item.criterion ? esc(item.criterion) : "None recorded yet. Accepting asks for one."}</p></section>
    ${renderCandidates(view, detail)}
    ${renderDecision(view, detail)}
    ${follow && item.issue ? renderFollowThrough(view, detail, follow) : ""}
    ${renderHistoryOf(detail, follow)}
  </article>`;
}

const EVIDENCE_SHOWN = 6;

function renderEvidence(view: ImprovementsView, detail: ImprovementDetail): string {
  const evidence = detail.evidence;
  const shown = view.expanded ? evidence : evidence.slice(0, EVIDENCE_SHOWN);
  const entry = (source: (typeof evidence)[number]) =>
    source.kind === "review_finding"
      ? `<li><code>${esc(source.location)}</code> <span class="muted">${esc(source.repository)} · ${esc(source.status)} · last seen ${esc(utcTime(source.lastSeenAt))}</span></li>`
      : `<li><p>${esc(source.excerpt)}</p><span class="muted">${esc(source.repository)} · ${esc(source.sourceKind)} · ${esc(utcTime(source.occurredAt))}${source.retroId ? ` · <a href="${esc(routeHref({ view: "improvements", tab: "report", id: source.retroId }))}">retro report</a>` : ""}</span></li>`;
  const toggle =
    evidence.length > EVIDENCE_SHOWN
      ? `<button class="btn" type="button" data-improvement-action="evidence" aria-expanded="${view.expanded}" aria-controls="improvement-evidence-list">${view.expanded ? "Show fewer sources" : `Show all ${evidence.length} sources`}</button>`
      : "";
  return `<section class="improvement-part" aria-labelledby="improvement-evidence"><h3 id="improvement-evidence">Evidence</h3>${
    evidence.length
      ? `<ul class="improvement-evidence" id="improvement-evidence-list">${shown.map(entry).join("")}</ul>${toggle}`
      : `<p class="muted">No evidence you can read is attached.</p>`
  }</section>`;
}

function renderCandidates(view: ImprovementsView, detail: ImprovementDetail): string {
  if (!detail.candidates.length) return "";
  const id = detail.item.id;
  const entries = detail.candidates.map((candidate) => {
    const others = candidate.improvements.filter((other) => other !== id);
    const shared = others.length
      ? ` <span class="muted">also linked from ${others.map((other) => `<a href="${esc(itemHref(other, view.filter))}">${others.length === 1 ? "another improvement" : esc(other.slice(-6))}</a>`).join(", ")}</span>`
      : "";
    const reuse =
      detail.item.lifecycle === "needs_review" && candidate.issue.identifier
        ? ` <button class="btn" type="button" data-improvement-action="use-issue" data-issue="${esc(candidate.issue.identifier)}"${disabled(view)}>Link this issue</button>`
        : "";
    return `<li class="row">${issueLink(candidate.issue)}${shared}${reuse}</li>`;
  });
  return `<section class="improvement-part" aria-labelledby="improvement-candidates"><h3 id="improvement-candidates">Existing issues in ${esc(detail.item.repository)}</h3><p class="muted">Paws suggests these; it never links or comments on its own.</p><ul class="improvement-candidates">${entries.join("")}</ul></section>`;
}

function draft(view: ImprovementsView, name: string, fallback = ""): string {
  return view.drafts[name] ?? fallback;
}

function input(
  view: ImprovementsView,
  name: string,
  label: string,
  options: { fallback?: string; required?: boolean; max?: number; placeholder?: string } = {},
) {
  return `<label class="field"><span>${esc(label)}</span><input type="text" name="${name}" data-improvement-draft="${name}" value="${esc(draft(view, name, options.fallback))}"${options.required ? " required" : ""}${options.max ? ` maxlength="${options.max}"` : ""}${options.placeholder ? ` placeholder="${esc(options.placeholder)}"` : ""} autocomplete="off" /></label>`;
}

function defaultChoice(detail: ImprovementDetail): DecisionChoice {
  return detail.candidates.some((candidate) => candidate.issue.identifier) ? "link" : "create";
}

function renderDecision(view: ImprovementsView, detail: ImprovementDetail): string {
  const item = detail.item;
  if (item.lifecycle === "needs_review") return renderChoices(view, detail);
  if (item.lifecycle === "rejected")
    return `<section class="improvement-part" aria-labelledby="improvement-decision"><h3 id="improvement-decision">Decision</h3><p>Rejected${item.decision.by ? ` by ${esc(item.decision.by)}` : ""}${item.decision.at ? ` ${esc(utcTime(item.decision.at))}` : ""}: ${esc(item.decision.reason ?? "")}</p><p class="muted">No issue was filed. It stays in this history.</p><button class="btn" type="button" data-improvement-action="reopen"${disabled(view)}>Reopen for review</button></section>`;
  const intent =
    item.decision.intent === "link"
      ? `link ${item.decision.intentIssueId ? `<span class="lin-id">${esc(item.decision.intentIssueId)}</span>` : "an existing issue"}${item.decision.evidenceComment ? " and add an evidence comment" : ""}`
      : "create an issue";
  const accepted = `<p>Accepted${item.decision.by ? ` by ${esc(item.decision.by)}` : ""}${item.decision.at ? ` ${esc(utcTime(item.decision.at))}` : ""}: ${intent}.</p>`;
  const linked = item.issue ? `<p>Linear issue ${issueLink(item.issue)}.</p>` : "";
  const legacy = item.legacy.length
    ? `<p class="muted">Earlier Findings actions: ${item.legacy.map((action) => `${esc(action.kind)}${action.issue ? ` <span class="lin-id">${esc(action.issue)}</span>` : ""}`).join(", ")}.</p>`
    : "";
  return `<section class="improvement-part" aria-labelledby="improvement-decision"><h3 id="improvement-decision">Decision and filing</h3>${accepted}${linked}${legacy}${renderDeliveries(view, detail)}</section>`;
}

function renderChoices(view: ImprovementsView, detail: ImprovementDetail): string {
  const choice = view.choice ?? defaultChoice(detail);
  const button = (value: DecisionChoice, label: string) =>
    `<button class="btn${choice === value ? " on" : ""}" type="button" data-improvement-choice="${value}" aria-pressed="${choice === value}"${disabled(view)}>${label}</button>`;
  const item = detail.item;
  const criterion = item.criterion
    ? ""
    : input(view, "criterion", "Verification criterion", {
        required: true,
        max: 1000,
        placeholder: "How you will know the change worked",
      });
  const busy = view.busy === "decision";
  const submit = (label: string) =>
    `<button class="btn primary" type="submit"${disabled(view)}>${busy ? "Saving…" : label}</button>`;
  let form: string;
  if (choice === "reject")
    form = `<form class="col" data-improvement-form="reject">${input(view, "reason", "Why reject it?", { required: true, max: 500, placeholder: "Not recurring, tracked elsewhere…" })}<p class="muted">A rejection stays in history and files nothing.</p>${submit("Reject with this reason")}</form>`;
  else if (choice === "link") {
    const fallback = detail.candidates.find((c) => c.issue.identifier)?.issue.identifier ?? "";
    const comment = draft(view, "comment") === "true";
    const closed =
      view.confirmClosed !== null
        ? `<p class="checkout-error" role="alert"><span class="lin-id">${esc(view.confirmClosed)}</span> is closed. Linking does not reopen it.</p><button class="btn" type="button" data-improvement-action="link-closed"${disabled(view)}>Link the closed issue</button>`
        : "";
    form = `<form class="col" data-improvement-form="link">${input(view, "issue", "Linear issue", { fallback, required: true, max: 200, placeholder: "PAS-123" })}<label class="row"><input type="checkbox" name="comment" data-improvement-draft="comment" value="true"${comment ? " checked" : ""} /><span>Also add an evidence comment to the issue</span></label>${criterion}<p class="muted">Paws links ${esc(draft(view, "issue", fallback) || "the issue")} ${comment ? "and posts one evidence comment" : "and posts nothing to it"}. It does not change the issue.</p>${closed}${submit(comment ? "Link and add evidence" : "Link issue")}</form>`;
  } else {
    const teams = detail.destinations;
    const team = draft(view, "team", teams[0] ?? "");
    form = teams.length
      ? `<form class="col" data-improvement-form="create"><label class="field"><span>Linear team</span><select name="team" data-improvement-draft="team">${teams.map((id) => `<option value="${esc(id)}"${id === team ? " selected" : ""}>${esc(id)}</option>`).join("")}</select></label>${criterion}<p class="muted">Paws files one issue in this team, in Triage, with the proposal and its evidence counts. It does not delegate it.</p>${submit("File the issue")}</form>`
      : `<p class="muted">No Linear team you belong to is mapped to ${esc(item.repository)}. Link an existing issue, or ask an admin to map a team.</p>`;
  }
  return `<section class="improvement-part" aria-labelledby="improvement-decision"><h3 id="improvement-decision">Decide</h3><div class="row" role="group" aria-label="Decision">${button("create", "Create issue")}${button("link", "Link existing issue")}${button("reject", "Reject")}</div>${form}</section>`;
}

function renderDeliveries(view: ImprovementsView, detail: ImprovementDetail): string {
  const deliveries = detail.item.deliveries;
  if (!deliveries.length) return "";
  return `<ul class="improvement-deliveries">${deliveries
    .map((delivery) => {
      const state =
        delivery.status === "succeeded"
          ? tag("Done", "done")
          : delivery.status === "pending"
            ? tag(
                delivery.attempts ? `Retrying · attempt ${delivery.attempts + 1}` : "Filing",
                "now",
              )
            : delivery.status === "unknown"
              ? tag("Checking with Linear", "warn")
              : tag("Needs you", "err");
      const explain =
        delivery.status === "unknown"
          ? "Paws does not know yet whether Linear received this. It checks the same operation and never files a second issue."
          : delivery.status === "retryable"
            ? `Not filed${delivery.blocked ? `: ${BLOCK_LABEL[delivery.blocked] ?? delivery.blocked}` : delivery.error ? `: ${delivery.error}` : ""}. The acceptance is kept.`
            : delivery.status === "pending" && delivery.nextAttemptAt
              ? `Next attempt ${utcTime(delivery.nextAttemptAt)}.`
              : "";
      const actions: string[] = [];
      if (delivery.recovery === "retry")
        actions.push(
          `<button class="btn" type="button" data-improvement-action="retry" data-delivery="${esc(delivery.id)}"${disabled(view)}>Retry filing</button>`,
        );
      if (delivery.recovery === "reopen")
        actions.push(
          `<button class="btn" type="button" data-improvement-action="reopen"${disabled(view)}>Reopen and choose again</button>`,
        );
      if (delivery.recovery === "cancel_comment")
        actions.push(
          `<button class="btn" type="button" data-improvement-action="cancel-comment" data-delivery="${esc(delivery.id)}"${disabled(view)}>Drop the evidence comment</button>`,
        );
      if (delivery.recovery === "choose_destination" && detail.destinations.length)
        actions.push(
          `<form class="row" data-improvement-form="destination" data-delivery="${esc(delivery.id)}"><label class="field"><span>File in team</span><select name="destination" data-improvement-draft="destination">${detail.destinations.map((id) => `<option value="${esc(id)}"${id === draft(view, "destination", detail.destinations[0]) ? " selected" : ""}>${esc(id)}</option>`).join("")}</select></label><button class="btn" type="submit"${disabled(view)}>File there</button></form>`,
        );
      return `<li class="col"><div class="row"><b>${esc(DELIVERY_LABEL[delivery.operation])}</b>${state}${delivery.issue ? issueLink(delivery.issue) : ""}<span class="muted">${esc(utcTime(delivery.updatedAt))}</span></div>${explain ? `<p class="muted">${esc(explain)}</p>` : ""}${actions.length ? `<div class="row">${actions.join("")}</div>` : ""}</li>`;
    })
    .join("")}</ul>`;
}

function renderFollowThrough(
  view: ImprovementsView,
  detail: ImprovementDetail,
  follow: ImprovementFollowThroughDetail,
): string {
  const f = follow.followThrough;
  const issue = f.issue!;
  const sync = issue.sync;
  const confirmed = sync?.confirmedAt ?? issue.confirmedAt;
  const syncLine =
    sync && sync.status !== "available"
      ? `Paws cannot read it now (${esc(sync.status)}); last confirmed ${esc(utcTime(confirmed))}.`
      : `Last confirmed ${esc(utcTime(confirmed))}${issue.fresh ? "" : " · not read for over 6 hours"}.`;
  const work = f.work;
  const workLine = work
    ? `<p>Paws work <a href="${esc(routeHref({ view: "issues", id: work.itemId }))}"><span class="lin-id">${esc(work.itemId)}</span></a> is ${esc(work.state)}${work.pull ? `, pull request #${work.pull.number}` : ""}${work.merge ? `, merged${work.merge.sha ? ` at <code>${esc(work.merge.sha.slice(0, 12))}</code>` : ""} ${esc(utcTime(work.merge.confirmedAt))}` : ""}.</p>`
    : "";
  const merged =
    f.implementation.state === "merged" || f.implementation.state === "completed"
      ? `<p class="muted">A merge or a Done issue is implementation progress. It does not prove the change is deployed or that it fixed the problem.</p>`
      : "";
  const delegate = f.delegate.offered
    ? `<button class="btn primary" type="button" data-improvement-action="delegate"${disabled(view)}>${view.busy === "delegate" ? "Delegating…" : "Delegate to Paws"}</button><p class="muted">Starts the normal Paws workflow on the issue. Nothing starts until you choose this.</p>`
    : f.delegation && f.delegation.state !== "failed"
      ? `<p>Delegated ${esc(utcTime(f.delegation.requestedAt))} (${esc(f.delegation.state)}).</p>`
      : f.delegate.reason === "existing_work"
        ? `<p class="muted">The issue already has work or a delegate; Paws follows it instead of starting another.</p>`
        : f.delegate.reason === "issue_closed"
          ? `<p class="muted">The issue is closed, so Paws does not delegate it.</p>`
          : "";
  const failed =
    f.delegation?.state === "failed"
      ? `<p class="checkout-error" role="alert">Delegation did not start${f.delegation.error ? `: ${esc(f.delegation.error)}` : ""}.</p>`
      : "";
  return `<section class="improvement-part" aria-labelledby="improvement-follow"><h3 id="improvement-follow">Follow-through</h3>
    <dl class="kv"><dt>Issue</dt><dd>${issueLink(issue)} · ${syncLine}</dd>
    <dt>Implementation</dt><dd>${esc(IMPLEMENTATION_LABEL[f.implementation.state] ?? f.implementation.state)}${f.implementation.source === "linear" ? " (from Linear)" : ""}${f.implementation.at ? ` · ${esc(utcTime(f.implementation.at))}` : ""}</dd>
    <dt>Verification</dt><dd>${esc(VERIFICATION_LABEL[f.verification.state] ?? f.verification.state)}${f.verification.at ? ` · ${esc(utcTime(f.verification.at))}` : ""}${f.verification.stale === "recurred" ? " · the finding was seen again" : f.verification.stale === "reopened" ? " · the work or issue reopened" : ""}</dd></dl>
    ${workLine}${merged}${failed}${delegate}
    ${renderVerification(view, f)}
    ${renderRecovery(view, f)}
  </section>`;
}

function renderVerification(
  view: ImprovementsView,
  f: ImprovementFollowThroughDetail["followThrough"],
): string {
  if (!f.verification.criterion)
    return `<form class="col" data-improvement-form="criterion">${input(view, "new-criterion", "Verification criterion", { required: true, max: 1000, placeholder: "How you will know the change worked" })}<button class="btn" type="submit"${disabled(view)}>Save criterion</button></form>`;
  const done = f.implementation.state === "merged" || f.implementation.state === "completed";
  if (!done || f.attention === "closed") return "";
  const verified = f.verification.state === "verified" && !f.verification.stale;
  const outcome = draft(view, "outcome", verified ? "contradicted" : "verified");
  const revision = f.work?.merge?.sha ?? "";
  return `<form class="col" data-improvement-form="verification"><h4>${verified ? "Record contrary evidence" : "Record verification"}</h4><p class="muted">Criterion: ${esc(f.verification.criterion)}</p>
    <label class="field"><span>Outcome</span><select name="outcome" data-improvement-draft="outcome">${verified ? "" : `<option value="verified"${outcome === "verified" ? " selected" : ""}>Verified: the criterion holds</option>`}<option value="contradicted"${outcome === "contradicted" ? " selected" : ""}>Contradicted: the criterion does not hold</option></select></label>
    ${input(view, "check", "What you checked", { required: true, max: 300 })}
    ${input(view, "result", "What it showed", { required: true, max: 1000 })}
    ${input(view, "revision", "Revision", { fallback: revision, max: 40, placeholder: "Merged commit sha" })}
    ${input(view, "deployment", "Deployed version", { max: 200, placeholder: "Optional, instead of a revision" })}
    ${input(view, "url", "Evidence link", { max: 2000, placeholder: "https://…" })}
    <button class="btn primary" type="submit"${disabled(view)}>${view.busy === "verification" ? "Saving…" : "Record"}</button></form>`;
}

function renderRecovery(
  view: ImprovementsView,
  f: ImprovementFollowThroughDetail["followThrough"],
): string {
  if (!f.recovery.length) return "";
  return `<form class="col" data-improvement-form="recovery"><h4>Recovery</h4>${input(view, "recovery-reason", "Why", { required: true, max: 500 })}<div class="row">${f.recovery.map((choice) => `<button class="btn" type="submit" name="choice" value="${choice}"${disabled(view)}>${RECOVERY_LABEL[choice]}</button>`).join("")}</div></form>`;
}

function renderHistoryOf(
  detail: ImprovementDetail,
  follow: ImprovementFollowThroughDetail | null,
): string {
  const entries = [
    ...detail.decisions.map((d) => ({
      at: d.at,
      text: `${d.reviewState === "needs_review" ? "reopened" : d.reviewState} by ${d.actor}${d.reason ? `: ${d.reason}` : ""}`,
    })),
    ...(follow?.outcomes ?? []).map((o) => ({
      at: o.recordedAt,
      text: `${o.track === "implementation" ? "Implementation" : "Verification"}: ${(o.track === "implementation" ? IMPLEMENTATION_LABEL : VERIFICATION_LABEL)[o.state] ?? o.state}${o.actor && o.actor !== "paws" ? ` by ${o.actor}` : ""}`,
    })),
  ].sort((a, b) => b.at - a.at);
  if (!entries.length) return "";
  return `<section class="improvement-part" aria-labelledby="improvement-history"><h3 id="improvement-history">History</h3><ul class="improvement-history">${entries
    .slice(0, 12)
    .map((e) => `<li><span class="muted">${esc(utcTime(e.at))}</span> ${esc(e.text)}</li>`)
    .join("")}</ul></section>`;
}

function renderReport(view: ImprovementsView): string {
  const back = `<a class="btn" href="${esc(routeHref({ view: "improvements", tab: "history", id: null }))}">All retros</a>`;
  if (view.reportState === "missing")
    return `${back}<div class="empty" role="status"><div>Retro not available</div>This retro is not available to you, or it does not exist. <a href="${esc(routeHref({ view: "improvements", tab: "history", id: null }))}">Return to the history</a>.</div>`;
  if (view.report === null)
    return view.reportState === "error"
      ? `${back}<div class="empty" role="status"><div>Retro unavailable</div>${esc(view.error ?? "")}<div><button class="btn primary" type="button" data-improvement-action="reload">Retry</button></div></div>`
      : `${back}<div class="empty" role="status">Loading the retro…</div>`;
  const { retro, report, coverageGaps } = view.report;
  const head = `<div class="col"><h2>${esc(period(retro.windowStart, retro.windowEnd))}</h2><p class="muted">${retro.origin === "manual" ? "Manual retro" : "Scheduled retro"} · ${esc(retro.repositories.join(", "))}${retro.publishedAt ? ` · published ${esc(utcTime(retro.publishedAt))}` : ""}${retro.fullAccess ? "" : " · showing only what you can read"}</p></div>`;
  if (report === null) {
    const state = retro.generation.state ?? "queued";
    const recover =
      state === "failed"
        ? `<button class="btn primary" type="button" data-improvement-action="run-retro"${disabled(view)}>Retry generation</button>`
        : state === "waiting_for_runner"
          ? `<a class="btn" href="${esc(routeHref({ view: "runners", id: null }))}">Check runners</a>`
          : `<button class="btn" type="button" data-improvement-action="reload">Refresh</button>`;
    const detail =
      retro.generation.error ??
      retro.generation.detail ??
      "The report appears here once generated.";
    return `${back}${head}<div class="card" role="status"><div class="row">${tag(GENERATION_LABEL[state] ?? state, state === "failed" ? "err" : state === "generating" ? "now" : "warn")}</div><p>${esc(detail)}</p><p class="muted">The evidence is saved. Waiting for a runner spends no agent time.</p><div class="row">${recover}</div></div>`;
  }
  const windows = report.windows.length
    ? `<p class="muted">Reporting window: ${report.windows.map((w) => `${esc(w.repository)} ${esc(utcTime(w.start))} to ${esc(utcTime(w.end))}`).join("; ")}. Frozen when the retro ran.</p>`
    : "";
  const numbers = report.numbers?.length
    ? `<ul class="row improvement-numbers" aria-label="Numbers">${report.numbers.map((n) => `<li><b>${n.value}</b> ${esc(n.label)}</li>`).join("")}</ul>`
    : "";
  const items = report.items.length
    ? `<ol class="improvement-report-items">${report.items.map((item) => reportItem(view, item)).join("")}</ol>`
    : `<div class="empty" role="status"><div>No recurring patterns</div>This retro found no pattern repeated across sessions. Nothing needs review from it.</div>`;
  const worked = report.workedWell.length
    ? `<section class="improvement-part"><h3>Worked well</h3><ul>${report.workedWell.map((w) => `<li>${esc(w.observation)} <span class="muted">${esc(w.repository)}</span></li>`).join("")}</ul></section>`
    : "";
  const notes = report.notes.length
    ? `<section class="improvement-part"><h3>Notes</h3><ul>${report.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></section>`
    : "";
  const gaps = coverageGaps?.length
    ? `<section class="improvement-part"><h3>Coverage gaps</h3><ul>${coverageGaps.map((g) => `<li>${esc(g.kind)}${g.repository ? ` · ${esc(g.repository)}` : ""}${g.detail ? `: ${esc(g.detail)}` : ""}</li>`).join("")}</ul></section>`
    : "";
  return `${back}${head}${windows}${numbers}<section class="improvement-part" aria-labelledby="report-patterns"><h3 id="report-patterns">Patterns (${report.items.length} of at most 5)</h3>${items}</section>${worked}${notes}${gaps}`;
}

function reportItem(
  view: ImprovementsView,
  item: NonNullable<RetroReportResponse["report"]>["items"][number],
): string {
  const improvement = item.improvement;
  const link = improvement
    ? `<a class="btn" href="${esc(itemHref(improvement.improvementId, view.filter))}">Open in the inbox</a>${improvement.reviewState ? tag(improvement.reviewState === "needs_review" ? "Needs review" : improvement.reviewState) : ""}`
    : "";
  const counts = `${item.counts.sessions} session${item.counts.sessions === 1 ? "" : "s"} · ${item.counts.events} event${item.counts.events === 1 ? "" : "s"}${item.counts.byWorkItem.length ? ` · ${item.counts.byWorkItem.map((w) => `<span class="lin-id">${esc(w.identifier)}</span> ${w.events}`).join(", ")}` : ""}`;
  const prior = item.priorWork.length
    ? `<p class="muted">Earlier work: ${item.priorWork.map((p) => `${p.issueIdentifier ? `<span class="lin-id">${esc(p.issueIdentifier)}</span>` : "an improvement"} (${esc(p.relation.replaceAll("_", " "))})`).join(", ")}</p>`
    : "";
  return `<li class="card col"><div class="row">${tag(item.action.step)}<span class="muted">${esc(item.repository)} / ${esc(item.area)}</span></div><h4>${esc(item.title)}</h4><p>${esc(item.explanation)}</p><p class="muted">${counts}</p><p><b>Proposed change:</b> ${esc(item.action.change)}</p><p><b>Verify:</b> ${esc(item.verification)}</p>${prior}<div class="row">${link}</div></li>`;
}

function renderHistory(view: ImprovementsView): string {
  if (view.history === null)
    return view.historyError
      ? `<div class="empty" role="status"><div>History unavailable</div>${esc(view.historyError)}<div><button class="btn primary" type="button" data-improvement-action="reload">Retry</button></div></div>`
      : `<div class="empty" role="status">Loading retro history…</div>`;
  if (!view.history.retros.length)
    return `<div class="empty" role="status"><div>No retros yet</div>Your first retro reads the recorded sessions of the selected repositories.<div><button class="btn primary" type="button" data-improvement-action="run-retro"${disabled(view)}>Run the first retro</button></div></div>`;
  const rows = view.history.retros
    .map((retro) => {
      const state = retro.generation.state;
      const status =
        state === "ready" || retro.publishedAt
          ? retro.items.toReview
            ? tag(`${retro.items.toReview} to review`, "warn")
            : tag(`${retro.items.visible} reviewed`, "done")
          : tag(GENERATION_LABEL[state ?? "queued"] ?? "Queued", state === "failed" ? "err" : "");
      return `<tr><td><a href="${esc(routeHref({ view: "improvements", tab: "report", id: retro.id }))}">${esc(period(retro.windowStart, retro.windowEnd))}</a></td><td class="hide-phone">${esc(retro.repositories.join(", "))}</td><td>${status}</td></tr>`;
    })
    .join("");
  const more = view.history.nextCursor
    ? `<button class="btn" type="button" data-improvement-action="more-history"${view.busy === "more" ? " disabled" : ""}>Show older retros</button>`
    : "";
  return `<p class="muted">Each retro keeps its frozen report, window and evidence. ${view.history.total} retro${view.history.total === 1 ? "" : "s"}.</p><table><thead><tr><th>Window</th><th class="hide-phone">Repositories</th><th>Review</th></tr></thead><tbody>${rows}</tbody></table>${more}`;
}

function renderSettings(view: ImprovementsView): string {
  const schedule = view.schedule;
  const daily = `<section class="card col" aria-labelledby="settings-daily"><h2 id="settings-daily">Daily findings</h2><p>Daily grouping keeps its own settings.</p><a class="btn" href="${esc(routeHref({ view: "settings", page: "findings" }))}">Finding settings</a></section>`;
  if (schedule === null)
    return `${daily}<div class="empty" role="status">Loading the retro schedule…</div>`;
  const s = schedule.schedule;
  const when = schedule.nextRun
    ? `Next retro ${utcTime(schedule.nextRun.at)}.`
    : schedule.saved
      ? "Weekly retros are paused."
      : "Retro settings are not saved yet, so no retro is scheduled.";
  const facts = Object.entries(s)
    .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
    .map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(String(value))}</dd>`)
    .join("");
  return `${daily}<section class="card col" aria-labelledby="settings-weekly"><h2 id="settings-weekly">Weekly retros</h2><p>${esc(when)}</p>${facts ? `<dl class="kv">${facts}</dl>` : ""}<p class="muted">${schedule.canEdit ? "Workspace admins change the prompt, agent, repositories and schedule in retro settings." : "Only workspace admins change the retro schedule."} A manual retro uses the same saved settings.</p>${schedule.canRun ? `<div class="row"><button class="btn" type="button" data-improvement-action="run-retro"${disabled(view)}>Run retro</button></div>` : ""}</section>`;
}
