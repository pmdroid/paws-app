import { improvementStage, stageAllows } from "./improvement-stage";
import {
  DEFAULT_IMPROVEMENT_FILTER,
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
  type RetroArtifact,
  type RetroCurrentOutcome,
  type RetroHistory,
  type RetroHistoryEntry,
  type RetroItemEvidence,
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
  /** The report item the address selects (`?item=`), kept across reload and Back/Forward. */
  item: string | null;
  itemEvidence: RetroItemEvidence | null;
  itemEvidenceState: "idle" | "loading" | "ready" | "missing" | "error";
  download: { file: RetroArtifact | null; error: string | null };
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

/** The review card's source badge: muted for daily findings, the verifying color for retros. */
const SOURCE_BADGE = {
  daily_finding: `<span class="st">daily findings</span>`,
  retro_item: `<span class="st verifying">weekly retro</span>`,
} as const;

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

const FINDINGS_LABEL = "Handled in Findings";
const FINDINGS_NEXT =
  "A Findings action already filed, added or is filing these findings. Follow that issue from Findings; the inbox does not decide it again.";

const tag = (label: string, tone = "") =>
  `<span class="tag wrap${tone ? ` ${tone}` : ""}">${esc(label)}</span>`;

const attentionTag = (state: AttentionState) =>
  tag(ATTENTION_LABEL[state], ATTENTION_TONE[state] ?? "");

function attentionOf(view: ImprovementsView, item: ImprovementItem): AttentionState | null {
  const stage = improvementStage(item);
  if (stage === "findings" || (stage === "rejected" && item.reviewState !== "rejected"))
    return null;
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
    const badge =
      count && count > 0
        ? ` <b class="font-mono text-xs font-normal" aria-label="${count} need attention">${count}</b>`
        : "";
    return `<a class="btn seg" href="${esc(href)}"${current ? ' aria-current="page"' : ""}>${esc(label)}${badge}</a>`;
  };
  return `<nav class="segmented" aria-label="Improvement pages">${tab("review", "Review", view.attention?.counts.total)}${tab("history", "History")}${tab("settings", "Settings")}</nav>`;
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
  return "Nothing to review. Daily findings and weekly retros appear here after some work has merged.";
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
  const state = attention
    ? attentionTag(attention)
    : improvementStage(item) === "findings"
      ? tag(FINDINGS_LABEL)
      : tag(LIFECYCLE_LABEL[item.lifecycle]);
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
  const span = evidencePeriod(detail);
  const field = (id: string, label: string, body: string) =>
    `<section class="improvement-field" aria-labelledby="improvement-${id}"><h3 class="improvement-label" id="improvement-${id}">${label}</h3>${body}</section>`;
  return `${back}${stale}<article class="improvement-detail" data-improvement="${esc(item.id)}">
    <header class="improvement-head">${SOURCE_BADGE[item.sourceKind]}<h2 id="improvement-heading" tabindex="-1">${esc(item.proposal.title)}</h2>${span ? `<span class="mono improvement-period">${esc(span)}</span>` : ""}</header>
    <div class="row">${tag(item.proposal.actionStep)}<span class="muted">${esc(item.repository)}</span>${attention ? attentionTag(attention) : ""}</div>
    <p class="muted">${esc(attention ? NEXT_ACTION[attention] : improvementStage(item) === "findings" ? FINDINGS_NEXT : LIFECYCLE_LABEL[item.lifecycle])}</p>
    <div class="improvement-fields" data-improvement-fields="">
      ${field("problem", "Problem", `<p>${esc(item.proposal.problem)}</p>`)}
      ${field("change", "Intended change", `<p>${esc(item.proposal.proposedChange)}</p>`)}
      ${field("evidence", "Evidence", renderEvidence(view, detail))}
      ${field("criterion", "Verification criterion", `<p>${item.criterion ? esc(item.criterion) : improvementStage(item) === "review" ? "None recorded yet. Accepting asks for one." : "None recorded yet."}</p>`)}
    </div>
    ${renderDecision(view, detail)}
    ${renderCandidates(view, detail)}
    ${improvementStage(item) === "accepted" && follow?.followThrough.issue ? renderFollowThrough(view, follow, follow.followThrough.issue) : ""}
    ${renderHistoryOf(detail, follow)}
  </article>`;
}

const EVIDENCE_SHOWN = 6;

/** The days the item's evidence spans, the period the card header shows. */
function evidencePeriod(detail: ImprovementDetail): string {
  const times = detail.evidence
    .map((source) => (source.kind === "review_finding" ? source.lastSeenAt : source.occurredAt))
    .filter(Number.isFinite);
  if (!times.length) return "";
  const first = day(Math.min(...times));
  const last = day(Math.max(...times));
  return first === last ? first : `${first} – ${last}`;
}

function renderEvidence(view: ImprovementsView, detail: ImprovementDetail): string {
  const evidence = detail.evidence;
  const shown = view.expanded ? evidence : evidence.slice(0, EVIDENCE_SHOWN);
  const entry = (source: (typeof evidence)[number]) =>
    source.kind === "review_finding"
      ? `<li><code>${esc(source.location)}</code> <span class="muted">${esc(source.repository)} · ${esc(source.status)} · last seen ${esc(utcTime(source.lastSeenAt))}</span></li>`
      : `<li><code>${esc(source.ref)}</code><p>${esc(source.excerpt)}</p><span class="muted">${esc(source.repository)} · ${esc(source.sourceKind)} · ${esc(utcTime(source.occurredAt))}${source.retroId ? ` · <a href="${esc(routeHref({ view: "improvements", tab: "report", id: source.retroId }))}">retro report</a>` : ""}</span></li>`;
  const toggle =
    evidence.length > EVIDENCE_SHOWN
      ? `<button class="btn" type="button" data-improvement-action="evidence" aria-expanded="${view.expanded}" aria-controls="improvement-evidence-list">${view.expanded ? "Show fewer sources" : `Show all ${evidence.length} sources`}</button>`
      : "";
  return evidence.length
    ? `<ul class="improvement-evidence" id="improvement-evidence-list">${shown.map(entry).join("")}</ul>${toggle}`
    : `<p class="muted">No evidence you can read is attached.</p>`;
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
      stageAllows(detail.item, "use-issue") && candidate.issue.identifier
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
  const stage = improvementStage(item);
  const legacy = item.legacy.length
    ? `<p class="muted">Earlier Findings actions: ${item.legacy.map((action) => `${esc(action.kind)}${action.issue ? ` <span class="lin-id">${esc(action.issue)}</span>` : ""}`).join(", ")}.</p>`
    : "";
  if (stage === "findings")
    return `<section class="improvement-part" aria-labelledby="improvement-decision"><h3 id="improvement-decision">Handled in Findings</h3>${item.issue?.identifier ? `<p>Linear issue <span class="lin-id">${esc(item.issue.identifier)}</span>.</p>` : ""}${legacy}<p class="muted">${esc(FINDINGS_NEXT)}</p><a class="btn" href="${esc(routeHref({ view: "findings" }))}">Open Findings</a></section>`;
  if (stage === "review") return renderChoices(view, detail);
  if (stage === "rejected")
    return `<section class="improvement-part" aria-labelledby="improvement-decision"><h3 id="improvement-decision">Decision</h3>${
      item.reviewState === "rejected"
        ? `<p>Rejected${item.decision.by ? ` by ${esc(item.decision.by)}` : ""}${item.decision.at ? ` ${esc(utcTime(item.decision.at))}` : ""}: ${esc(item.decision.reason ?? "")}</p>`
        : `<p>Dismissed from Findings.</p>`
    }${legacy}<p class="muted">No issue was filed. It stays in this history.</p>${stageAllows(item, "reopen") ? `<button class="btn" type="button" data-improvement-action="reopen"${disabled(view)}>Reopen for review</button>` : ""}</section>`;
  const intent =
    item.decision.intent === "link"
      ? `link ${item.decision.intentIssueId ? `<span class="lin-id">${esc(item.decision.intentIssueId)}</span>` : "an existing issue"}${item.decision.evidenceComment ? " and add an evidence comment" : ""}`
      : "create an issue";
  const accepted = `<p>Accepted${item.decision.by ? ` by ${esc(item.decision.by)}` : ""}${item.decision.at ? ` ${esc(utcTime(item.decision.at))}` : ""}: ${intent}.</p>`;
  const linked = item.issue ? `<p>Linear issue ${issueLink(item.issue)}.</p>` : "";
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
  return `<section class="improvement-part" aria-labelledby="improvement-decision"><h3 class="sr-only" id="improvement-decision">Decide</h3><div class="row improvement-actions" role="group" aria-label="Decision">${button("create", "Create issue")}${button("link", "Link existing issue")}${button("reject", "Reject")}</div>${form}</section>`;
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
  follow: ImprovementFollowThroughDetail,
  issue: NonNullable<ImprovementFollowThroughDetail["followThrough"]["issue"]>,
): string {
  const f = follow.followThrough;
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

type OutcomeRecord = ImprovementFollowThroughDetail["outcomes"][number];

function verificationEvidence(o: OutcomeRecord): string {
  const facts: string[] = [];
  for (const entry of o.evidence) {
    const split = entry.indexOf(":");
    const kind = split < 0 ? entry : entry.slice(0, split);
    const value = split < 0 ? "" : entry.slice(split + 1);
    if (kind === "check") facts.push(`<dt>Checked</dt><dd>${esc(value)}</dd>`);
    else if (kind === "result") facts.push(`<dt>Showed</dt><dd>${esc(value)}</dd>`);
    else if (kind === "closeout") facts.push(`<dt>Closeout step</dt><dd>${esc(value)}</dd>`);
    else if (kind === "url") {
      const href = safeHref(value);
      facts.push(
        `<dt>Evidence</dt><dd>${href ? `<a href="${esc(href)}" target="_blank" rel="noreferrer noopener">${esc(value)}</a>` : esc(value)}</dd>`,
      );
    }
  }
  if (o.revision) facts.push(`<dt>Revision</dt><dd><code>${esc(o.revision)}</code></dd>`);
  if (o.deployment) facts.push(`<dt>Deployed version</dt><dd>${esc(o.deployment)}</dd>`);
  return facts.length ? `<dl class="kv">${facts.join("")}</dl>` : "";
}

function renderHistoryOf(
  detail: ImprovementDetail,
  follow: ImprovementFollowThroughDetail | null,
): string {
  const entries = [
    ...detail.decisions.map((d) => ({
      at: d.at,
      html: esc(
        `${d.reviewState === "needs_review" ? "reopened" : d.reviewState} by ${d.actor}${d.reason ? `: ${d.reason}` : ""}`,
      ),
    })),
    ...(follow?.outcomes ?? []).map((o) => ({
      at: o.recordedAt,
      html: `${esc(`${o.track === "implementation" ? "Implementation" : "Verification"}: ${(o.track === "implementation" ? IMPLEMENTATION_LABEL : VERIFICATION_LABEL)[o.state] ?? o.state}${o.actor && o.actor !== "paws" ? ` by ${o.actor}` : ""}`)}${o.track === "verification" ? verificationEvidence(o) : ""}`,
    })),
  ].sort((a, b) => b.at - a.at);
  if (!entries.length) return "";
  return `<section class="improvement-part" aria-labelledby="improvement-history"><h3 id="improvement-history">History</h3><ul class="improvement-history">${entries
    .slice(0, 12)
    .map((e) => `<li><span class="muted">${esc(utcTime(e.at))}</span> ${e.html}</li>`)
    .join("")}</ul></section>`;
}

const historyHref = () => esc(routeHref({ view: "improvements", tab: "history", id: null }));

function reportItemHref(retroId: string, itemId: string): string {
  return `${routeHref({ view: "improvements", tab: "report", id: retroId })}?item=${encodeURIComponent(itemId)}`;
}

function profileText(retro: RetroHistoryEntry): string | null {
  if (retro.profile === null || retro.settingsRevision === null) return null;
  const { agent, model, effort } = retro.profile;
  return `Settings revision ${retro.settingsRevision} · ${agent ?? "Unknown agent"} · ${model ?? "agent default model"} · ${effort ? `${effort} effort` : "default effort"}`;
}

const ARTIFACT_LABEL: Record<RetroArtifact, string> = {
  digest: "Download digest",
  report: "Download report",
  prompt: "Download rendered prompt",
};

const RETENTION =
  "Paws keeps these files with the retro but sets no retention period, so a file can still go missing; this page says when one has.";

function renderDownloads(view: ImprovementsView, response: RetroReportResponse): string {
  const { retro } = response;
  const error = view.download.error
    ? `<p class="checkout-error" role="alert" data-retro-download-error="">${esc(view.download.error)}</p>`
    : "";
  if (!retro.fullAccess || retro.artifacts === null)
    return `<section class="improvement-part" aria-labelledby="retro-files"><h3 id="retro-files">Frozen files</h3><p data-retro-downloads="denied">Downloads need access to every repository and session this retro includes. You can read part of it, so Paws shows only the items you can read and no download.</p>${error}</section>`;
  const artifacts = retro.artifacts;
  const button = (file: RetroArtifact) => {
    const state = artifacts[file];
    if (state !== "stored")
      return `<span class="muted" data-retro-artifact="${file}">${esc(ARTIFACT_LABEL[file].replace("Download ", ""))}: ${state === "unavailable" ? "the stored file is unavailable" : "never stored"}</span>`;
    const busy = view.download.file === file;
    return `<button class="btn" type="button" data-improvement-action="download" data-file="${file}"${view.download.file !== null ? " disabled" : ""}>${busy ? "Downloading…" : ARTIFACT_LABEL[file]}</button>`;
  };
  const windows = response.report?.windows ?? [];
  const window = windows.length
    ? windows
        .map((w) => `${esc(w.repository)} ${esc(utcTime(w.start))} to ${esc(utcTime(w.end))}`)
        .join("; ")
    : esc(period(retro.windowStart, retro.windowEnd));
  const digest = retro.digest;
  const coverage = digest
    ? `${digest.sessions} session${digest.sessions === 1 ? "" : "s"}, ${digest.counted} counted record${digest.counted === 1 ? "" : "s"}${digest.context ? `, and ${digest.context} earlier record${digest.context === 1 ? "" : "s"} included only as bounded prompt context, not counted` : ""}`
    : "no digest was saved";
  const evidence =
    retro.evidence === "expired"
      ? " Some source evidence had expired before Paws collected it; the digest says what is missing and Paws does not fill it in from current sessions."
      : retro.evidence === "incomplete"
        ? " Some source evidence was unavailable when Paws collected it; see the coverage gaps."
        : "";
  return `<section class="improvement-part" aria-labelledby="retro-files"><h3 id="retro-files">Frozen files</h3><p>The digest is the original evidence saved when the retro ran, not rebuilt from current sessions. Window: ${window}. Coverage: ${esc(coverage)}.${esc(evidence)}</p>${promptCoverageText(response)}<p class="muted">${esc(RETENTION)}</p><div class="row" data-retro-downloads="full">${(["digest", "report", "prompt"] as const).map(button).join("")}</div>${error}</section>`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** What the agent was actually given, kept apart from the full digest's coverage above it. */
function promptCoverageText(response: RetroReportResponse): string {
  const p = response.promptCoverage;
  if (p === null)
    return `<p data-retro-prompt-coverage="unknown">Paws did not save how much of this digest the prompt included, so the agent may have seen less than the full digest.</p>`;
  const omitted = p.sessionsOmitted + p.countedOmitted + p.contextOmitted;
  const given = `The agent received a bounded view of the digest${p.maxChars ? ` (at most ${p.maxChars} characters)` : ""}: ${plural(p.sessionsIncluded, "session")}, ${plural(p.countedIncluded, "counted record")} and ${plural(p.contextIncluded, "context record")}.`;
  const left = omitted
    ? ` Left out of the prompt but kept in the digest: ${plural(p.sessionsOmitted, "session")}, ${plural(p.countedOmitted, "counted record")} and ${plural(p.contextOmitted, "context record")}. The digest's totals still count them.`
    : " Nothing was left out.";
  return `<p data-retro-prompt-coverage="${omitted ? "bounded" : "complete"}">${esc(given + left)}</p>`;
}

function renderReport(view: ImprovementsView): string {
  const back = `<a class="btn" href="${historyHref()}">All retros</a>`;
  if (view.reportState === "missing")
    return `${back}<div class="empty" role="status"><div>Retro not available</div>This retro is not available to you, or it does not exist. <a href="${historyHref()}">Return to the history</a>.</div>`;
  if (view.report === null)
    return view.reportState === "error"
      ? `${back}<div class="empty" role="status"><div>Retro unavailable</div>${esc(view.error ?? "")}<div><button class="btn primary" type="button" data-improvement-action="reload">Retry</button></div></div>`
      : `${back}<div class="empty" role="status">Loading the retro…</div>`;
  const { retro, report, coverageGaps } = view.report;
  const frozen = retro.fullAccess ? `<div data-retro-frozen="${esc(retro.id)}"></div>` : "";
  const head = `<div class="col"><h2 id="retro-report-heading" tabindex="-1">${esc(period(retro.windowStart, retro.windowEnd))}</h2><p class="muted">${retro.origin === "manual" ? "Manual retro" : "Scheduled retro"} · ${esc(retro.repositories.join(", "))}${retro.publishedAt ? ` · published ${esc(utcTime(retro.publishedAt))}` : ""}${retro.fullAccess ? "" : " · showing only what you can read"}</p></div>`;
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
    return `${back}${head}${frozen}<div class="card" role="status"><div class="row">${tag(GENERATION_LABEL[state] ?? state, state === "failed" ? "err" : state === "generating" ? "now" : "warn")}</div><p>${esc(detail)}</p><p class="muted">The evidence is saved. Waiting for a runner spends no agent time.</p><div class="row">${recover}</div></div>${renderDownloads(view, view.report)}`;
  }
  const windows = report.windows.length
    ? `<p class="muted">Reporting window: ${report.windows.map((w) => `${esc(w.repository)} ${esc(utcTime(w.start))} to ${esc(utcTime(w.end))}`).join("; ")}. Frozen when the retro ran.</p>`
    : "";
  const numbers = report.numbers?.length
    ? `<ul class="row improvement-numbers" aria-label="Numbers">${report.numbers.map((n) => `<li><b>${n.value}</b> ${esc(n.label)}</li>`).join("")}</ul>`
    : "";
  const selected = view.item;
  const missingItem =
    selected !== null && !report.items.some((item) => item.itemId === selected)
      ? `<div class="empty" role="status" tabindex="-1" data-retro-item-missing=""><div>Item not available</div>This report has no item you can read with that id. <a href="${esc(routeHref({ view: "improvements", tab: "report", id: retro.id }))}">Show the whole report</a>.</div>`
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
    ? `<section class="improvement-part"><h3>Coverage gaps</h3><ul>${coverageGaps.map((g) => `<li>${esc(GAP_LABEL[g.kind] ?? g.kind)}${g.repository ? ` · ${esc(g.repository)}` : ""}${g.detail ? `: ${esc(g.detail)}` : ""}</li>`).join("")}</ul></section>`
    : "";
  return `${back}${head}${frozen}${windows}${numbers}${missingItem}<section class="improvement-part" aria-labelledby="report-patterns"><h3 id="report-patterns">Patterns (${report.items.length} of at most 5)</h3><p class="muted">Each pattern shows what the report claimed when it ran. "Now" shows the improvement's current outcome separately; it never rewrites the report.</p>${items}</section>${worked}${notes}${gaps}${renderDownloads(view, view.report)}`;
}

const GAP_LABEL: Record<string, string> = {
  missing_artifact: "A source file was missing",
  hash_mismatch: "A source file did not match its saved hash",
  retention_gap: "Source evidence had expired",
  source_unavailable: "A source was unavailable",
};

function currentOutcome(current: RetroCurrentOutcome | null | undefined): string {
  if (current === undefined) return "";
  if (current === null)
    return `<div class="improvement-now" data-retro-now="inaccessible"><b>Now</b> <span class="muted">You cannot see this improvement's current outcome.</span></div>`;
  const attention = current.attention as AttentionState;
  const issue = current.issue
    ? `${issueLink(current.issue)} <span class="muted">${current.issue.syncedAt ? `last read from Linear ${esc(utcTime(current.issue.syncedAt))}` : "not read from Linear yet"}${current.issue.fresh ? "" : " · not current"}</span>`
    : `<span class="muted">No confirmed issue</span>`;
  return `<div class="improvement-now col" data-retro-now="${esc(current.attention)}"><div class="row"><b>Now</b>${tag(ATTENTION_LABEL[attention] ?? current.attention, ATTENTION_TONE[attention] ?? "")}${issue}</div><p class="muted">Implementation: ${esc(IMPLEMENTATION_LABEL[current.implementation.state] ?? current.implementation.state)} · Verification: ${esc(VERIFICATION_LABEL[current.verification.state] ?? current.verification.state)}${current.verification.state === "verified" && current.verification.at ? ` ${esc(utcTime(current.verification.at))}` : ""}</p></div>`;
}

function savedEvidence(view: ImprovementsView, itemId: string): string {
  if (view.itemEvidenceState === "loading" || view.itemEvidenceState === "idle")
    return `<p class="muted" role="status">Loading the saved evidence…</p>`;
  if (view.itemEvidenceState === "missing")
    return `<p role="status">This item's saved evidence is not available to you.</p>`;
  if (
    view.itemEvidenceState === "error" ||
    view.itemEvidence?.itemId !== itemId ||
    view.itemEvidence.retroId !== view.report?.retro.id
  )
    return `<p role="status">The saved evidence did not load. <button class="btn" type="button" data-improvement-action="reload">Retry</button></p>`;
  const entries = view.itemEvidence.evidence;
  return entries.length
    ? `<ul class="improvement-evidence" aria-label="Saved evidence">${entries.map((e) => `<li><p>${esc(e.excerpt)}</p><span class="muted">${e.identifier ? `<span class="lin-id">${esc(e.identifier)}</span> · ` : ""}${esc(e.repository)} · ${esc(e.sourceKind)} · ${esc(utcTime(e.occurredAt))}</span></li>`).join("")}</ul>`
    : `<p role="status">Paws saved no excerpt for this item. It does not substitute current session records.</p>`;
}

function reportItem(
  view: ImprovementsView,
  item: NonNullable<RetroReportResponse["report"]>["items"][number],
): string {
  const retroId = view.report!.retro.id;
  const selected = view.item === item.itemId;
  const improvement = item.improvement;
  const link = improvement
    ? `<a class="btn" href="${esc(itemHref(improvement.improvementId, DEFAULT_IMPROVEMENT_FILTER))}">Open in the inbox</a>`
    : "";
  const inspect = selected
    ? `<a class="btn" href="${esc(routeHref({ view: "improvements", tab: "report", id: retroId }))}">Hide saved evidence</a>`
    : `<a class="btn" href="${esc(reportItemHref(retroId, item.itemId))}">Inspect saved evidence</a>`;
  const counts = `${item.counts.sessions} session${item.counts.sessions === 1 ? "" : "s"} · ${item.counts.events} event${item.counts.events === 1 ? "" : "s"}${item.counts.byWorkItem.length ? ` · ${item.counts.byWorkItem.map((w) => `<span class="lin-id">${esc(w.identifier)}</span> ${w.events}`).join(", ")}` : ""}`;
  const prior = item.priorWork.length
    ? `<p class="muted">Earlier work when it ran: ${item.priorWork.map((p) => `${p.issueIdentifier ? `<span class="lin-id">${esc(p.issueIdentifier)}</span>` : "an improvement"} (${esc(p.relation.replaceAll("_", " "))})`).join(", ")}</p>`
    : "";
  const evidence = selected
    ? `<section class="col" aria-labelledby="retro-item-evidence"><h5 id="retro-item-evidence" tabindex="-1">Saved evidence</h5>${savedEvidence(view, item.itemId)}</section>`
    : "";
  return `<li class="card col${selected ? " selected" : ""}" data-retro-item="${esc(item.itemId)}"${selected ? ' aria-current="true"' : ""}><div class="row">${tag(item.action.step)}<span class="muted">${esc(item.repository)} / ${esc(item.area)}</span>${improvement?.reviewState ? tag(`Decision: ${improvement.reviewState === "needs_review" ? "needs review" : improvement.reviewState}`) : ""}</div><h4>${esc(item.title)}</h4><p>${esc(item.explanation)}</p><p class="muted">${counts}</p><p><b>Proposed change:</b> ${esc(item.action.change)}</p><p><b>Verify:</b> ${esc(item.verification)}</p>${prior}${currentOutcome(improvement ? view.report!.current[item.itemId] : undefined)}${evidence}<div class="row">${inspect}${link}</div></li>`;
}

function historyState(retro: RetroHistoryEntry): string {
  const state = retro.generation.state;
  if (state !== "ready" && !retro.publishedAt)
    return tag(GENERATION_LABEL[state ?? "queued"] ?? "Queued", state === "failed" ? "err" : "");
  if (retro.patterns === 0) return tag("No recurring patterns", "done");
  return retro.items.toReview
    ? tag(`${retro.items.toReview} to review`, "warn")
    : tag(`${retro.items.visible} reviewed`, "done");
}

function historyNotes(retro: RetroHistoryEntry): string {
  const notes: string[] = [];
  if (retro.evidence === "expired") notes.push(tag("Evidence expired", "warn"));
  else if (retro.evidence === "incomplete") notes.push(tag("Evidence incomplete", "warn"));
  if (retro.artifacts?.digest === "unavailable") notes.push(tag("Digest unavailable", "err"));
  if (!retro.fullAccess) notes.push(tag("Partial view"));
  return notes.join("");
}

function historyLinks(retro: RetroHistoryEntry): string {
  const linked = retro.items.links.filter((link) => link.issue !== null);
  return linked.length
    ? linked.map((link) => issueLink(link.issue!)).join(" ")
    : `<span class="muted">None</span>`;
}

function renderHistory(view: ImprovementsView): string {
  if (view.history === null)
    return view.historyError
      ? `<div class="empty" role="status"><div>History unavailable</div>${esc(view.historyError)}<div><button class="btn primary" type="button" data-improvement-action="reload">Retry</button></div></div>`
      : `<div class="empty" role="status">Loading retro history…</div>`;
  if (!view.history.retros.length)
    return `<div class="empty" role="status"><div>No reports yet</div>No retro has been saved yet. Your first retro reads the recorded sessions of the selected repositories.<div><button class="btn primary" type="button" data-improvement-action="run-retro"${disabled(view)}>Run the first retro</button></div></div>`;
  const rows = view.history.retros
    .map((retro) => {
      const href = esc(routeHref({ view: "improvements", tab: "report", id: retro.id }));
      return `<tr data-retro-row="${esc(retro.id)}"><td><a href="${href}"><b>${esc(period(retro.windowStart, retro.windowEnd))}</b></a><div class="muted">${retro.origin === "manual" ? "Manual" : "Scheduled"} · ${esc(retro.repositories.join(", "))}</div>${profileText(retro) ? `<div class="muted">${esc(profileText(retro)!)}</div>` : ""}</td><td class="hide-phone">${retro.digest ? retro.digest.sessions : `<span class="muted">—</span>`}</td><td class="retro-state"><div class="row">${historyState(retro)}${historyNotes(retro)}</div></td><td class="hide-phone">${historyLinks(retro)}</td></tr>`;
    })
    .join("");
  const more = view.history.nextCursor
    ? `<button class="btn" type="button" data-improvement-action="more-history"${view.busy === "more" ? " disabled" : ""}>Show older retros</button>`
    : "";
  const shown = view.history.retros.length;
  return `<p class="muted">Saved retros, newest period first. Each retro keeps its frozen report and the digest it was generated from. ${esc(RETENTION)} Showing ${shown} of ${view.history.total} retro${view.history.total === 1 ? "" : "s"}.</p><table><thead><tr><th>Period</th><th class="hide-phone">Sessions</th><th>Review</th><th class="hide-phone">Linked issues</th></tr></thead><tbody>${rows}</tbody></table>${more}`;
}

function renderSettings(view: ImprovementsView): string {
  const schedule = view.schedule;
  const daily = `<section class="card col" aria-labelledby="settings-daily"><h2 id="settings-daily">Daily findings</h2><p>Daily grouping is switched on the Findings page.</p><a class="btn" href="${esc(routeHref({ view: "findings" }))}">Findings page</a></section>`;
  const form = `<div class="card" data-retro-settings=""></div>`;
  if (schedule === null)
    return `${daily}<div class="empty" role="status">Loading the retro schedule…</div>${form}`;
  const s = schedule.schedule;
  const when = schedule.nextRun
    ? `Next retro ${utcTime(schedule.nextRun.at)}.`
    : schedule.saved
      ? "Weekly retros are paused. No retro runs until someone selects Run retro."
      : "Retro settings are not saved yet, so no retro is scheduled.";
  const facts = Object.entries(s)
    .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
    .map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(String(value))}</dd>`)
    .join("");
  return `${daily}<section class="card col" aria-labelledby="settings-weekly"><h2 id="settings-weekly">Weekly retros</h2><p>${esc(when)}</p>${facts ? `<dl class="kv">${facts}</dl>` : ""}<p class="muted">${schedule.canEdit ? "Workspace admins change the prompt, agent, repositories and schedule in retro settings below." : "Only workspace admins change the retro schedule."} A manual retro uses the same saved settings and joins a retro already in flight for its window.</p>${schedule.canRun ? `<div class="row"><button class="btn" type="button" data-improvement-action="run-retro"${disabled(view)}>Run retro</button></div>` : ""}</section>${form}`;
}
