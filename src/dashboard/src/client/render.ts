import { SETTINGS_PAGES, renderSettingsPage } from "./settings-pages";
import type {
  EvidenceListResponse,
  EvidenceMetadataResponse,
  MergeQueueResponse,
  OverviewIssue,
  OverviewResponse,
  IssueDetailResponse,
  IssueListResponse,
  StatusItem,
  StatusItemEvent,
  StatusLink,
  QuestionDetailResponse,
  QuestionListResponse,
  StatusRun,
  StatusRunSetup,
  StatusUsagePause,
  StatusVerdict,
} from "../contract";
import {
  ago,
  clock,
  clock24,
  esc,
  linkButtons,
  safeHref,
  linkList,
  mergeQueueLine,
  queueLine,
  capLine,
  heldLine,
  waitReason,
  skillVersionLabel,
  statePill,
  utcClock,
} from "./format";
import { routeHref, routeResource, type Route } from "./route";
import { parseEngineUrl } from "./format";
import {
  emptyCloseoutView,
  renderCloseoutChecks,
  sectionOpen,
  sectionToggle,
  type CloseoutView,
} from "./closeout";
import { renderRuleResults } from "./rules";
import { agentProgress, findAgentCloseout, renderAgentCloseout } from "./agent-closeout";
import { reviewFindingsSection } from "./review-findings";
import {
  evidenceSlot,
  renderEvidenceGallery,
  renderEvidencePage,
  type MediaInfo,
} from "./evidence";
import { PAGES } from "./navigation";
import { renderMergeQueue } from "./merge-queue";
import { renderIntake } from "./intake";
import { renderSetupChecklist } from "./setup-checklist";
import { renderPushOutages } from "./push-outage";
import { renderPolicyRunnerWarnings } from "./policy-runners";
import { hoursLabel, itemAge, mergedTimesSection, stateTimeBar } from "./state-times";
import {
  doingLabel,
  doingTimeLine,
  issueTimeLine,
  itemPill,
  itemTime,
  PREPARING_LABEL,
} from "./doing";
import { journey, journeyStepper } from "./journey";
import { deadDeliveriesSection } from "./dead-deliveries";
import { visualReviewSection } from "./visual-review";
import { LINK_ASK_ACTIONS, LINK_ASK_ANCHORS, linkAskCard, riskCarryOverCard } from "./link-ask";
import { riskCard } from "./risk";
import { renderQuestions } from "./questions";
import { dashboardPath } from "../../../dashboard-links";

export interface RenderModel {
  route: Route;
  phase: "loading" | "ready" | "error";
  overview?: OverviewResponse | null;
  mergeQueue?: MergeQueueResponse | null;
  issues?: IssueListResponse | null;
  issue?: IssueDetailResponse | null;
  questions?: QuestionListResponse | null;
  question?: QuestionDetailResponse | null;
  missingQuestion?: string | null;
  evidenceList?: EvidenceListResponse | null;
  evidence?: EvidenceMetadataResponse | null;
  missingEvidence?: string | null;
  error: string | null;
  engineUrl: string | null;
  closeout?: CloseoutView;
  mediaInfo?: ReadonlyMap<string, MediaInfo>;
}

export interface Rendered {
  top: string;
  banner: string;
  content: string;
  title: string;
}

/** The Findings page loads its own data into this root. */
const FINDINGS_ROOT = `${pageHeading("findings")}<div id="findings-page"></div>`;
const IMPROVEMENTS_ROOT = `${pageHeading("improvements")}<div id="improvements-page"></div>`;

const IMPLEMENTING = new Set(["queued", "planning", "running", "awaiting_input"]);

export function render(model: RenderModel): Rendered {
  const route = model.route;
  const pageTitle =
    route.view === "settings"
      ? SETTINGS_PAGES.find((page) => page.id === (route.page ?? "agents"))!.name
      : PAGES[model.route.view].title;
  const title = `Paws status · ${pageTitle}`;
  return {
    top: renderTop(model),
    banner: renderBanner(model),
    content:
      model.route.view === "alias"
        ? renderAlias(model)
        : model.route.view === "runners"
          ? '<div id="runner-settings"></div>'
          : model.route.view === "findings"
            ? FINDINGS_ROOT
            : model.route.view === "improvements"
              ? IMPROVEMENTS_ROOT
              : model.route.view === "settings"
                ? renderSettingsPage(model.route.page)
                : model.route.view === "questions"
                  ? renderQuestions({
                      selected: model.route.id,
                      list: model.questions ?? null,
                      detail:
                        model.question?.question.id === model.route.id ? model.question : null,
                      missing: model.route.id !== null && model.missingQuestion === model.route.id,
                      error: model.phase === "error" ? model.error : null,
                    })
                  : model.route.view === "evidence"
                    ? renderEvidence(model)
                    : model.route.view === "overview"
                      ? model.overview
                        ? viewOverview(model.overview)
                        : renderPending(model)
                      : model.route.view === "mergeQueue"
                        ? viewMergeQueue(model)
                        : model.phase !== "loading" && openDetail(model)
                          ? issuePage(
                              model.issue!,
                              model.closeout ?? emptyCloseoutView(),
                              model.engineUrl,
                            )
                          : model.phase !== "loading" && model.issues && route.view === "issues"
                            ? viewIssues(model.issues, route.id)
                            : model.phase !== "loading" && model.issues && route.view === "runs"
                              ? viewRuns(model.issues, route.id)
                              : renderPending(model),
    title,
  };
}

/** The issue page has its detail; the issue list is not read for it. */
export function openDetail(model: Pick<RenderModel, "route" | "issue">): boolean {
  return (
    model.route.view === "issues" &&
    model.route.id !== null &&
    model.issue?.issue.id === model.route.id
  );
}

function renderTop(_model: RenderModel): string {
  return "";
}

function renderBanner(model: RenderModel): string {
  const resource = routeResource(model.route);
  if (model.phase === "error" && resource !== null) {
    const kept =
      resource === "overview"
        ? model.overview
        : resource === "mergeQueue"
          ? model.mergeQueue
          : resource === "questions"
            ? model.questions
            : resource === "question"
              ? model.question
              : resource === "evidenceGallery"
                ? model.evidenceList
                : resource === "evidence"
                  ? model.evidence
                  : openDetail(model) || model.issues;
    return `<div class="err-bar" role="status"><span class="n">Offline</span><span>${esc(model.error ?? "Could not load status")}.${kept ? " Showing the last loaded page." : ""}</span></div>`;
  }
  return "";
}

function viewMergeQueue(model: RenderModel): string {
  const queue = model.mergeQueue;
  if (!queue || model.phase === "loading") return renderPending(model);
  return `${pageHeading("mergeQueue")}${renderPushOutages(queue)}${renderPolicyRunnerWarnings(queue)}${renderMergeQueue(queue)}`;
}

function renderPending(model: RenderModel): string {
  if (model.phase === "error") {
    return `${pageHeading(model.route.view)}<div class="empty"><div>Status unavailable</div>${esc(model.error ?? "The engine did not return this page.")}<div><button class="btn primary" type="button" data-action="refresh">Retry</button></div></div>`;
  }
  return `${pageHeading(model.route.view)}<div class="empty" role="status">Loading status…</div>`;
}

function renderAlias(model: RenderModel): string {
  if (model.phase !== "ready") return renderPending(model);
  return `${pageHeading("alias")}<div class="empty">Link not found. It points to work that does not exist or that you cannot see.<div><a class="btn" href="${esc(routeHref({ view: "issues", id: null }))}">Open the issue list</a></div></div>`;
}

function renderEvidence(model: RenderModel): string {
  const route = model.route;
  if (route.view !== "evidence") return renderPending(model);
  const info = model.mediaInfo ?? new Map();
  if (route.id === null)
    return model.evidenceList
      ? renderEvidenceGallery(model.evidenceList, info, model.engineUrl)
      : renderPending(model);
  if (model.evidence?.evidence.id === route.id)
    return renderEvidencePage(model.evidence, info, model.engineUrl);
  if (model.missingEvidence === route.id) return renderEvidencePage(null, info, model.engineUrl);
  return renderPending(model);
}

/** One row of the overview's Needs you list. A primary button is a decision only a person makes. */
type NeedsYou = {
  itemId: string;
  title: string;
  reason: string;
  action: string;
  href: string;
  primary?: boolean;
};

function needsYou(overview: OverviewResponse): NeedsYou[] {
  const attention = overview.issues.flatMap((item): NeedsYou[] => {
    const run = item.run;
    const question = overview.questions.find((entry) => entry.itemId === item.id);
    if (question?.linkAsk)
      return [
        {
          itemId: item.id,
          title: item.title,
          reason: question.linkAsk.detail || question.linkAsk.title,
          action: LINK_ASK_ACTIONS[question.linkAsk.kind],
          href: `${routeHref({ view: "issues", id: item.id })}#${LINK_ASK_ANCHORS[question.linkAsk.kind]}`,
          primary: question.linkAsk.kind !== "question" && question.linkAsk.kind !== "rounds",
        },
      ];
    if (question)
      return [
        {
          itemId: item.id,
          title: item.title,
          reason: question.title,
          action: "Answer question",
          href: routeHref({ view: "questions", id: question.id }),
        },
      ];
    if (DONE_STATES.includes(item.state)) return [];
    const stopped = item.state === "awaiting_input" || item.state === "needs_human";
    const verdict = stopped ? item.verdict : null;
    const reason =
      verdict?.decision === "exhausted"
        ? "Automatic retries are used up."
        : item.state === "needs_human" || verdict?.decision === "blocked"
          ? "Work is blocked and needs a person."
          : item.state === "awaiting_input" || run?.state === "awaiting_input"
            ? "Waiting for your input."
            : run?.state === "paused"
              ? "This issue is paused."
              : null;
    return reason
      ? [
          {
            itemId: item.id,
            title: item.title,
            reason,
            action: "Review issue",
            href: routeHref({ view: "issues", id: item.id }),
          },
        ]
      : [];
  });
  for (const question of overview.questions) {
    if (overview.issues.some((item) => item.id === question.itemId)) continue;
    attention.push({
      itemId: question.itemId,
      title: question.title,
      reason: "Waiting for your answer.",
      action: "Answer question",
      href: routeHref({ view: "questions", id: question.id }),
    });
  }
  return attention;
}

const DONE_STATES: readonly string[] = ["merged", "completed", "stopped"];
const CLOSED_STATES: readonly string[] = [...DONE_STATES, "cancelled"];
const RECENTLY_MERGED = 5;
const IN_FLIGHT = ["running", "verifying", "recovering"] as const;
/** Active states lead the items table in this order; any other open state follows them, then queued. */
const TABLE_ORDER = [...IN_FLIGHT, "awaiting_input", "paused", "merge_queue", "manual", "failed"];

function tableRank(state: string): number {
  if (state === "queued") return TABLE_ORDER.length + 1;
  const at = TABLE_ORDER.indexOf(state);
  return at === -1 ? TABLE_ORDER.length : at;
}

function statTile(label: string, value: number, detail: string, tone = ""): string {
  return `<div class="card stat-tile gap-1"><div class="text-xs text-muted-foreground">${esc(label)}</div><div class="font-mono text-2xl ${tone}" data-stat-value>${value}</div><div class="font-mono text-[11px] text-muted-foreground">${esc(detail)}</div></div>`;
}

function statTiles(overview: OverviewResponse, open: OverviewIssue[]): string {
  const inState = (state: string) => open.filter((item) => item.state === state);
  const flight = IN_FLIGHT.map((state) => [state, inState(state).length] as const);
  const awaiting = inState("awaiting_input");
  const oldest = Math.max(
    0,
    ...awaiting.map(
      (item) => item.stateTimes?.states.find((entry) => entry.state === "awaiting_input")?.ms ?? 0,
    ),
  );
  const queued = inState("queued");
  return `<div class="grid grid-cols-2 md:grid-cols-4 gap-3" role="group" aria-label="Work at a glance">${[
    statTile(
      "In flight",
      flight.reduce((sum, [, count]) => sum + count, 0),
      flight.map(([state, count]) => `${state} ${count}`).join(" · "),
    ),
    statTile(
      "Awaiting input",
      awaiting.length,
      oldest > 0 ? `oldest ${hoursLabel(oldest)}` : awaiting.length ? "waiting" : "nothing waiting",
      awaiting.length ? "text-state-awaiting" : "",
    ),
    statTile("Merge queue", overview.mergeQueueCount, "accepted, waiting to merge"),
    statTile("Queued", queued.length, `${queued.filter((item) => item.held).length} held`),
  ].join("")}</div>`;
}

function itemsTable(open: OverviewIssue[], now: number): string {
  const rows = [...open]
    .sort((left, right) => tableRank(left.state) - tableRank(right.state))
    .map(
      (item) =>
        `<tr data-issue-id="${esc(item.id)}"><td><a href="${routeHref({ view: "issues", id: item.id })}"><span class="lin-id">${esc(item.id)}</span></a></td><td>${esc(item.title)}</td><td>${statePill(item.state, item.state)}</td><td>${waitingCell(item, now)}</td><td>${itemAge(item) || "—"}</td></tr>`,
    )
    .join("");
  return `<section class="flex min-w-0 flex-col gap-3" aria-labelledby="work-heading"><div class="between"><h2 id="work-heading">Items <span class="cnt">${open.length}</span></h2><a href="${routeHref({ view: "issues", id: null })}">All issues</a></div>
    ${
      open.length
        ? `<div class="overflow-x-auto [&_table]:min-w-[40rem] [&_td]:[overflow-wrap:normal] [&_th]:whitespace-nowrap [&_.lin-id]:whitespace-nowrap [&_.st]:whitespace-nowrap"><table class="run-table"><thead><tr><th>Item</th><th>Title</th><th>State</th><th>Waiting</th><th>Age</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : '<p class="muted">No open work right now.</p>'
    }</section>`;
}

/** What the item waits on: its queue line or hold, else what its runner is doing. */
function waitingCell(item: OverviewIssue, now: number): string {
  const wait = waitingFor(item);
  if (wait) return esc(wait);
  const label = item.doing?.stalled
    ? `Stalled: ${doingLabel(item) ?? "no live work and no change for 30 min"}`
    : doingLabel(item);
  const line = [label, doingTimeLine(item, now)].filter(Boolean).join(" · ");
  return line ? `<span data-item-time>${esc(line)}</span>` : "—";
}

function viewOverview(overview: OverviewResponse): string {
  const warnings = `${renderSetupChecklist(overview.setup)}${renderPushOutages(overview)}${renderPolicyRunnerWarnings(overview)}`;
  const intake = renderIntake(overview);
  if (!overview.issues.length && !overview.questions.length)
    return `${pageHeading("overview")}${warnings}${intake}<div class="empty">${esc(EMPTY_ISSUES)}<p class="muted">${esc(EMPTY_PAGES)}</p></div>`;
  const attention = needsYou(overview);
  const now = Date.parse(overview.generatedAt);
  const open = overview.issues.filter((item) => !CLOSED_STATES.includes(item.state));
  const merged = overview.issues
    .filter((item) => item.state === "merged")
    .map((item) => ({ item, at: mergedAt(item) }))
    .sort((left, right) => right.at.localeCompare(left.at))
    .slice(0, RECENTLY_MERGED);
  const count = (value: number) => ` <span class="cnt">${value}</span>`;
  return `${pageHeading("overview")}${warnings}
    <div class="flex min-w-0 flex-col gap-5">${statTiles(overview, open)}
    <div class="flex flex-wrap items-start gap-5"><div class="min-w-0 flex-[2_1_36rem]">${itemsTable(open, now)}</div>
    <div class="flex min-w-0 flex-1 basis-80 max-w-sm flex-col gap-5 max-md:max-w-none">
    <section class="overview-section" aria-labelledby="attention-heading"><h2 id="attention-heading">Needs you${count(attention.length)}</h2>
      ${attention.length ? `<ul class="overview-work" role="list">${attention.map((entry) => `<li class="overview-row" data-item="${esc(entry.itemId)}"><div class="overview-copy"><div><span class="lin-id">${esc(entry.itemId)}</span> <b>${esc(entry.title)}</b></div><p class="muted">${esc(entry.reason)}</p>${ageOf(overview, entry.itemId)}</div><a class="btn${entry.primary ? " primary" : ""}" href="${entry.href}" aria-label="${esc(`${entry.action}: ${entry.itemId}`)}">${esc(entry.action)}</a></li>`).join("")}</ul>` : '<p class="muted">Nothing needs your attention.</p>'}
    </section>
    ${intake}
    ${
      merged.length
        ? `<section class="overview-section" aria-labelledby="merged-heading"><h2 id="merged-heading">Recently merged</h2><ul class="overview-work" role="list">${merged
            .map(
              ({ item, at }) =>
                `<li class="work-row" data-item="${esc(item.id)}"><a class="work-title" href="${routeHref({ view: "issues", id: item.id })}"><span class="lin-id">${esc(item.id)}</span> <b>${esc(item.title)}</b></a><p class="work-facts"><span class="muted">${esc([item.pr ? `PR #${item.pr.number}` : "", at ? `merged ${ago(at, overview.generatedAt)}` : ""].filter(Boolean).join(" · "))}</span></p></li>`,
            )
            .join("")}</ul></section>`
        : ""
    }
    ${mergedTimesSection(overview.mergedTimes ?? undefined)}
    </div></div></div>`;
}

function waitingFor(item: OverviewIssue): string | null {
  if (item.queue && !item.held && !item.blockers.length) return queueLine(item.queue);
  return waitReason(item);
}

function mergedAt(item: OverviewIssue): string {
  const merge = [...(item.timeline ?? [])].reverse().find((event) => event.to === "merged");
  return merge?.at ?? item.stateTimes?.until ?? "";
}

function ageOf(overview: OverviewResponse, itemId: string): string {
  const item = overview.issues.find((entry) => entry.id === itemId);
  return item ? itemAge(item) : "";
}

const EMPTY_ISSUES = "No issues yet. Delegate an issue to Paws in Linear.";
const EMPTY_PAGES = "Questions, the merge queue and findings fill as work moves through Paws.";

function viewIssues(list: IssueListResponse, id: string | null): string {
  const selected = id ? list.issues.find((item) => item.id === id) : undefined;
  if (id && !selected)
    return `${pageHeading("issues")}<div class="empty">Issue not found. Choose an issue from the list.</div>${entityPicker(
      "Issue",
      list.issues.map((item) => ({
        value: routeHref({ view: "issues", id: item.id }),
        label: `${item.id} · ${item.title}`,
      })),
      "",
    )}`;
  // The issue page renders from its own detail; the list does not carry its Closeout attempts.
  if (selected) return issuePending();
  if (!list.issues.length)
    return `${pageHeading("issues")}<div class="empty">${esc(EMPTY_ISSUES)}</div>`;
  return `${pageHeading("issues")}
    <div class="issue-filters" role="group" aria-label="Filter issues">
      <button type="button" class="btn on" data-action="issue-filter" data-issue-filter="all" aria-pressed="true">All</button>
      <button type="button" class="btn" data-action="issue-filter" data-issue-filter="active" aria-pressed="false">Active</button>
      <button type="button" class="btn" data-action="issue-filter" data-issue-filter="needs" aria-pressed="false">Needs attention</button>
      <button type="button" class="btn" data-action="issue-filter" data-issue-filter="done" aria-pressed="false">Done</button>
    </div>
    ${projectFilter(list.issues)}
    <div class="overflow-x-auto [&_td]:[overflow-wrap:normal] [&_th]:whitespace-nowrap [&_.lin-id]:whitespace-nowrap [&_.st]:whitespace-nowrap"><table class="run-table issues-table"><thead><tr><th>Item</th><th>Title</th><th>State</th><th class="hide-phone">Project</th><th class="hide-phone">Waiting</th><th>Age</th></tr></thead><tbody>${list.issues.map((item) => issueRow(list.generatedAt, item)).join("")}</tbody></table></div>
    <p class="empty issue-filter-empty" hidden>No issues match this filter.</p>`;
}

function issuePending(): string {
  return `${pageHeading("issues")}<div class="empty" role="status">Loading issue…</div>`;
}

/** The value the project filter uses for issues without a Linear project. */
export const NO_PROJECT_FILTER = "none";

/** Whether an Issues row shows under a state filter and a project filter (empty for any). */
export function issueRowMatches(
  row: { state: string | undefined; project: string | undefined },
  filter: { state: "all" | "active" | "needs" | "done"; project: string },
): boolean {
  return (
    (filter.state === "all" || row.state === filter.state) &&
    (!filter.project || row.project === filter.project)
  );
}

/** A project picker built from the Linear projects of the listed issues. */
function projectFilter(items: readonly StatusItem[]): string {
  const projects = new Map<string, string>();
  for (const item of items) if (item.project) projects.set(item.project.id, item.project.name);
  if (!projects.size) return "";
  const options = [...projects]
    .sort(
      ([leftId, left], [rightId, right]) =>
        left.localeCompare(right) || leftId.localeCompare(rightId),
    )
    .map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`)
    .join("");
  const none = items.some((item) => !item.project)
    ? `<option value="${NO_PROJECT_FILTER}">No project</option>`
    : "";
  return `<label class="field issue-project-filter"><span>Project</span><select name="issue-project" data-issue-project-filter aria-label="Filter by project"><option value="">Any project</option>${options}${none}</select></label>`;
}

function issueRow(generatedAt: string, item: StatusItem): string {
  const blockers = item.blockers;
  const reason = waitReason(item) ?? (blockers.length ? `Blocked by ${blockers.join(", ")}` : null);
  const blocked = blockers.length
    ? `<div class="text-xs text-muted-foreground" data-blockers>${relatedIssues(blockers)}</div>`
    : "";
  return `<tr class="issue-row" data-issue-state="${issueBucket(item)}" data-issue-id="${esc(item.id)}" data-issue-project="${esc(item.project?.id ?? NO_PROJECT_FILTER)}"><td><a href="${routeHref({ view: "issues", id: item.id })}"><span class="lin-id">${esc(item.id)}</span></a></td><td>${esc(item.title)}${blocked}</td><td>${itemPill(item)}</td><td class="hide-phone">${esc(item.project?.name ?? "—")}</td><td class="hide-phone">${reason ? `<span class="muted" data-wait-reason>${esc(reason)}</span>` : "—"}</td><td>${itemTime(item, Date.parse(generatedAt)) || "—"}</td></tr>`;
}

function issueBucket(item: StatusItem): "needs" | "done" | "active" {
  if (["needs_human", "awaiting_input"].includes(item.state)) return "needs";
  if (item.state === "merged" || item.state === "completed") return "done";
  return "active";
}

function relatedIssues(ids: readonly string[]): string {
  return `<div class="row wrap">${issueLinks(ids)}</div>`;
}

function issueLinks(ids: readonly string[], separator = ""): string {
  return ids
    .map((id) => `<a href="${routeHref({ view: "issues", id })}">${esc(id)}</a>`)
    .join(separator);
}

function viewRuns(list: IssueListResponse, id: string | null): string {
  const run = id === null ? undefined : list.runs.find((entry) => inRun(entry, id));
  if (run && list.issues.some((item) => item.id === run.itemId)) return issuePending();
  return viewIssues(list, id);
}

/**
 * Everything about one issue: its state, the timeline of every engine run, Closeout, reviews,
 * questions, fix rounds, and the pull request and merge.
 */
function issuePage(
  snapshot: IssueDetailResponse,
  closeout: CloseoutView,
  engineUrl: string | null,
): string {
  const item = snapshot.issue;
  const earlier = snapshot.earlierSessions;
  const run = itemRun(snapshot, item, earlier);
  const verdict = attemptVerdict(snapshot, item, run);
  const engineRun = run?.attempts?.at(-1) ?? run?.id;
  const agent =
    run === undefined
      ? undefined
      : (findAgentCloseout(snapshot.agentCloseout, engineRun ?? run.id) ??
        findAgentCloseout(snapshot.agentCloseout, run.id));
  const engine = engineUrl === null ? null : parseEngineUrl(engineUrl);
  const transcriptPath =
    run === undefined ? null : dashboardPath(`/runs/${encodeURIComponent(run.id)}/transcript`);
  const transcriptHref =
    transcriptPath === null || snapshot.source !== "live"
      ? null
      : engine === null
        ? transcriptPath
        : new URL(transcriptPath, engine).href;
  const blocked = snapshot.blocks;
  const now = journey(item, run, verdict);
  const time = issueTimeLine(item, Date.parse(snapshot.generatedAt));
  const checks = verdict?.checks ?? [];
  const passed = checks.filter((check) => check.state === "passed").length;
  const rules = checks.filter((check) => check.kind === "rule");
  const brokenRules = rules.filter((check) => check.state === "failed").length;
  const reviews = (verdict as { reviews?: { rounds: unknown[] }[] } | undefined)?.reviews ?? [];
  const activity = run?.activity?.length ?? 0;
  return `${pageHeading("issues")}<article class="run-page issue-page">
    <nav class="crumbs" aria-label="Breadcrumb"><a href="${routeHref({ view: "issues", id: null })}">Issues</a><span>/</span><span class="lin-id">${esc(item.id)}</span></nav>
    <header class="issue-heading flex min-w-0 flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
      <div class="flex min-w-0 flex-col gap-2"><div class="flex flex-wrap gap-2 items-center"><span class="lin-id">${esc(item.id)}</span>${statePill(item.state, item.state)}${item.project ? `<span class="tag">project: ${esc(item.project.name)}</span>` : ""}<span class="tag">agent: ${esc(run?.agent ?? item.agent)}</span>${time ? `<span class="muted" data-item-now>${esc(time)}</span>` : ""}</div>
      <h1 class="issue-title text-xl font-semibold">${esc(item.title)}</h1>
      ${factLine([...issueFacts(snapshot, item, run, blocked), ["Repository", `<span${item.branch ? ` title="${esc(`Branch ${item.branch}`)}"` : ""}>${esc(snapshot.project.repo)}</span>`]])}</div>
      ${issueActions(item, run)}
    </header>
    ${journeyStepper(now, {
      ...(item.doing?.phase === "preparing"
        ? { implementing: doingLabel(item) ?? PREPARING_LABEL }
        : agent?.attempts.at(-1)?.checks.length
          ? { implementing: `Agent Closeout ${agentProgress(agent)}` }
          : {}),
      ...(item.state === "merge_queue" && item.mergeQueue
        ? { queue: item.mergeQueue.position }
        : {}),
    })}
    ${hostDiskFullNotice(item)}
    ${queueNotice(item, snapshot.generatedAt)}
    ${deadDeliveriesSection(snapshot, item.id)}
    ${run?.usagePause ? usagePauseSection(item, run, run.usagePause) : ""}
    ${snapshot.questions
      .filter(
        (question) =>
          question.itemId === item.id &&
          (run === undefined || question.runId === null || inRun(run, question.runId)) &&
          !item.visualReviews?.some((review) => review.questionId === question.id),
      )
      .map((question) =>
        question.linkAsk
          ? linkAskCard(question)
          : `<section class="closeout-result blocked"><div class="min-w-0"><h2>${esc(question.title)}</h2><p>${esc(plainTask(question.body))}</p><div class="row wrap">${linkList(question.links)}</div></div></section>`,
      )
      .join("")}
    ${visualReviewSection(snapshot, item, engineUrl, run?.itemId)}
    <div class="issue-folds">
    ${fold(
      closeout,
      `closeout:${item.id}`,
      "Closeout",
      verdict
        ? `${verdict.decision[0]!.toUpperCase()}${verdict.decision.slice(1)} · attempt ${verdict.attempt} of ${verdict.maxAttempts} · ${passed} of ${checks.length} checks passed`
        : "",
      verdict
        ? `<section class="closeout-section" aria-label="Closeout">${renderCloseoutChecks(verdict, closeout, engineUrl, item.pr, item.state)}</section>${agent ? renderAgentCloseout(agent, closeout, engineUrl, !IMPLEMENTING.has(item.state)) : ""}${run ? evidenceSlot(snapshot, run.id) : ""}`
        : "",
    )}
    ${verdict ? "" : `${agent ? renderAgentCloseout(agent, closeout, engineUrl, false) : ""}${run ? evidenceSlot(snapshot, run.id) : ""}`}
    ${fold(
      closeout,
      `findings:${item.id}`,
      "Review findings",
      `${reviews.length} review${reviews.length === 1 ? "" : "s"}`,
      verdict ? reviewFindingsSection(verdict, closeout) : "",
    )}
    ${fold(
      closeout,
      `rules:${item.id}`,
      "Rules",
      brokenRules ? `${brokenRules} broke` : `${rules.length} checked`,
      verdict ? renderRuleResults(verdict, closeout, engineUrl) : "",
      snapshot.questions.some(
        (question) => question.itemId === item.id && question.linkAsk?.kind === "rule",
      ),
    )}
    ${fold(
      closeout,
      `risk:${item.id}`,
      "Risk",
      "",
      `${riskCarryOverSection(snapshot, item)}${riskCard(snapshot.risk)}`,
      snapshot.questions.some(
        (question) => question.itemId === item.id && question.linkAsk?.kind === "risk",
      ),
    )}
    ${fold(
      closeout,
      `fixes:${item.id}`,
      "Fix rounds",
      `${now.fixRounds} round${now.fixRounds === 1 ? "" : "s"}`,
      fixRounds(snapshot, item, run),
    )}
    ${fold(closeout, `pr:${item.id}`, "Pull request and merge", item.pr ? `#${item.pr.number}` : "", pullRequestSection(snapshot, item))}
    ${fold(
      closeout,
      `timeline:${item.id}`,
      "Timeline",
      `${activity} event${activity === 1 ? "" : "s"}`,
      run
        ? `${stateTimeBar(item.stateTimes)}${activityActions(
            transcriptHref,
            run.links.filter((link) => !item.links.some((shown) => shown.href === link.href)),
          )}${activityLog(`activity-${run.id}`, run)}`
        : "",
      false,
      "activity-heading",
    )}
    ${runDetails(item, run, closeout)}
    </div>
  </article>`;
}

/** A collapsed section: its title and one-line summary, the body only once opened. */
function fold(
  view: CloseoutView,
  key: string,
  title: string,
  summary: string,
  body: string,
  pending = false,
  headingId = "",
): string {
  if (!body.trim()) return "";
  const open = sectionOpen(view, key, pending);
  const heading = `<h2${headingId ? ` id="${headingId}"` : ""}>${esc(title)}</h2>`;
  return `<section class="issue-fold" aria-label="${esc(title)}">${sectionToggle(key, open, heading, summary)}${open ? `<div class="issue-fold-body">${body}</div>` : ""}</section>`;
}

/** The kept approval, unless a risk ask on the item is open again. */
function riskCarryOverSection(snapshot: IssueDetailResponse, item: StatusItem): string {
  if (!item.riskCarryOver) return "";
  const asking = snapshot.questions.some(
    (question) => question.itemId === item.id && question.linkAsk?.kind === "risk",
  );
  return asking ? "" : riskCarryOverCard(item.riskCarryOver);
}

/** State, project, runner and agent, and the Linear session it belongs to. */
function issueFacts(
  snapshot: IssueDetailResponse,
  item: StatusItem,
  run: StatusRun | undefined,
  blocked: readonly string[],
): Array<[string, string]> {
  const facts: Array<[string, string]> = [
    ["Project", esc(item.project?.name ?? "No project")],
    ["Runner", esc(run?.runner ?? "Not placed yet")],
    ["Agent", esc(run?.agent ?? item.agent)],
  ];
  if (item.owner) facts.push(["Delegated by", esc(item.owner)]);
  if (run) facts.push(["Started", esc(ago(run.startedAt, snapshot.generatedAt))]);
  if (item.pr)
    facts.push([
      "Pull request",
      `<a href="${esc(item.pr.url)}" target="_blank" rel="noopener noreferrer">#${item.pr.number}</a>${item.state === "merged" ? " · merged" : ""}`,
    ]);
  if (item.blockers.length) facts.push(["Blocked by", issueLinks(item.blockers, ", ")]);
  if (blocked.length) facts.push(["Blocks", issueLinks(blocked, ", ")]);
  if (item.session) {
    const link = `<a href="${esc(item.session.url)}" target="_blank" rel="noopener noreferrer">Linear session</a>`;
    facts.push([
      "Session",
      item.session.shared.length
        ? `${link} shared with ${item.session.shared.map((other) => `<a class="lin-id" href="${routeHref({ view: "issues", id: other })}">${esc(other)}</a>`).join(", ")}`
        : link,
    ]);
  }
  return facts;
}

/** The header's facts as one mono line of `key value` pairs that wraps at any width. */
function factLine(facts: ReadonlyArray<[string, string]>): string {
  return `<div class="issue-facts flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-muted-foreground [overflow-wrap:anywhere]">${facts.map(([term, value]) => `<span class="min-w-0">${esc(term.toLowerCase())} <span class="text-foreground">${value}</span></span>`).join("")}</div>`;
}

const EXTERNAL_LINK =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"></path><path d="M10 14 21 3"></path><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3"></path></svg>';

function isLinear(href: string): boolean {
  try {
    return new URL(href).hostname === "linear.app";
  } catch {
    return false;
  }
}

/** Execution controls, then Open in Linear and Open GitHub when their URLs exist, then other links. */
function issueActions(item: StatusItem, run: StatusRun | undefined): string {
  const linear = item.links.find((link) => isLinear(link.href) && safeHref(link.href));
  const github = item.pr ? safeHref(item.pr.url) : null;
  const open = (href: string, label: string) =>
    `<a class="btn" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label)} ${EXTERNAL_LINK}</a>`;
  const rest = item.links.filter((link) => link !== linear && link.href !== item.pr?.url);
  const actions = [
    run && !run.usagePause ? executionControls(item, run) : "",
    linear ? open(safeHref(linear.href)!, "Open in Linear") : "",
    github ? open(github, "Open GitHub") : "",
    linkButtons(rest),
  ].join("");
  return actions
    ? `<div class="issue-actions flex flex-wrap gap-2 items-center lg:shrink-0 lg:justify-end">${actions}</div>`
    : "";
}

function factList(facts: ReadonlyArray<[string, string]>): string {
  return `<dl class="issue-facts-grid">${facts.map(([term, value]) => `<div><dt>${term}</dt><dd>${value}</dd></div>`).join("")}</dl>`;
}

function runDetails(item: StatusItem, run: StatusRun | undefined, view: CloseoutView): string {
  const facts: Array<[string, string]> =
    item.linearRequests === undefined ? [] : [["Linear requests", String(item.linearRequests)]];
  const parts = [
    facts.length ? factList(facts) : "",
    itemTimeline(item),
    run?.setup ? runSetupSection(run.setup) : "",
  ].filter(Boolean);
  if (!parts.length) return "";
  const summary = [
    stateChanges(item) ? `${stateChanges(item)} state changes` : "",
    run?.setup ? "skills and hooks" : "",
    facts.length ? "Linear requests" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return fold(
    view,
    `details:${item.id}`,
    "Run details",
    summary,
    `<div class="run-details">${parts.join("")}</div>`,
  );
}

const RESTART_REASON_LABELS: Record<string, string> = {
  findings: "Closeout findings",
  ci: "failing CI",
  review: "review feedback",
  conflict: "a merge conflict",
  follow_up: "a follow-up in Linear",
  answer: "an answer",
};

function stateChanges(item: StatusItem): number {
  return (item.timeline ?? []).filter((entry) => entry.kind !== "ci_rerun").length;
}

/** Every committed state change of the item and its agent's CI re-runs, oldest first. */
function itemTimeline(item: StatusItem): string {
  if (!item.timeline?.length) return "";
  return `<section class="item-timeline" aria-labelledby="item-timeline-heading"><h3 id="item-timeline-heading">State changes</h3>
    <ol class="timeline-list" role="list">${timelineGroups(item.timeline)
      .map((group) => (group.length === 1 ? itemTimelineEntry(group[0]!) : timelineLoop(group)))
      .join("")}</ol></section>`;
}

export function timelineGroups(entries: readonly StatusItemEvent[]): StatusItemEvent[][] {
  const same = (left: StatusItemEvent | undefined, right: StatusItemEvent | undefined) =>
    left !== undefined &&
    right !== undefined &&
    left.kind !== "ci_rerun" &&
    left.kind === right.kind &&
    left.from === right.from &&
    left.to === right.to &&
    left.event === right.event;
  const groups: StatusItemEvent[][] = [];
  let at = 0;
  while (at < entries.length) {
    let end = at;
    while (same(entries[end], entries[end + 2]) && same(entries[end + 1], entries[end + 3]))
      end += 2;
    if (end > at && entries[at]!.to !== entries[at + 1]!.to) {
      groups.push(entries.slice(at, end + 2));
      at = end + 2;
    } else {
      groups.push([entries[at]!]);
      at += 1;
    }
  }
  return groups;
}

const plainWords = (value: string) => esc(value.replaceAll("_", " "));

/** `event → state` in mono: what happened and the state it led to. */
function timelineMove(event: string, to: string, extra = ""): string {
  return `<p class="timeline-move font-mono text-xs">${esc(event)} <span class="text-muted-foreground"><span aria-hidden="true">→</span><span class="sr-only">to</span> ${esc(to)}</span>${extra}</p>`;
}

function timelineTime(at: string): string {
  return `<time datetime="${esc(at)}" title="${esc(at)}">${esc(clock24(at))}</time>`;
}

/** The dot takes its `to` state's color in the theme, as the state badge does. */
function timelineDot(to: string): string {
  return `<span class="timeline-dot" data-state="${esc(to)}" aria-hidden="true"></span>`;
}

function timelineEntry(kind: string, to: string, move: string, meta: string[]): string {
  return `<li data-kind="${esc(kind)}">${timelineDot(to)}<div class="timeline-body">${move}<p class="timeline-meta mono muted text-muted-foreground">${meta.filter(Boolean).join(" · ")}</p></div></li>`;
}

function timelineLoop(group: readonly StatusItemEvent[]): string {
  const [first, second] = group as [StatusItemEvent, StatusItemEvent];
  const last = group.at(-1)!;
  return timelineEntry(
    "loop",
    first.to,
    timelineMove(
      first.event,
      first.to,
      ` · ${esc(second.event)} <span class="text-muted-foreground"><span aria-hidden="true">→</span><span class="sr-only">to</span> ${esc(second.to)}</span> <span class="tag">${group.length / 2} times</span>`,
    ),
    [`${timelineTime(first.at)}–${timelineTime(last.at)}`],
  );
}

function ciRerunEntry(entry: StatusItemEvent): string {
  const runs = entry.runIds?.length
    ? `workflow run ${entry.runIds.map((id) => esc(String(id))).join(", ")}`
    : "";
  return timelineEntry("ci_rerun", entry.to, timelineMove("ci_rerun", entry.to), [
    timelineTime(entry.at),
    `CI re-run requested by the agent: ${esc(entry.reason ?? "")}`,
    runs,
  ]);
}

function itemTimelineEntry(entry: StatusItemEvent): string {
  if (entry.kind === "ci_rerun") return ciRerunEntry(entry);
  const why =
    entry.kind === "restart"
      ? `Back to the agent for ${esc(RESTART_REASON_LABELS[entry.reason ?? ""] ?? (entry.reason ?? "a restart").replaceAll("_", " "))}.`
      : entry.kind === "ask"
        ? `Asked a person: ${plainWords(entry.reason ?? "a question")}.`
        : entry.reason
          ? plainWords(entry.reason)
          : "";
  return timelineEntry(entry.kind, entry.to, timelineMove(entry.event, entry.to), [
    timelineTime(entry.at),
    why,
    entry.actor ? `by ${esc(entry.actor)}` : "",
  ]);
}

/** The pull request and where its merge stands. */
function pullRequestSection(snapshot: IssueDetailResponse, item: StatusItem): string {
  const entry = snapshot.mergeQueue.find((candidate) => candidate.itemId === item.id);
  const outcome = snapshot.mergeHistory.findLast((candidate) => candidate.itemId === item.id);
  const state =
    item.state === "merged"
      ? "Merged."
      : outcome?.outcome === "merged"
        ? `Merged at ${clock24(outcome.at)}.`
        : outcome?.outcome === "back_with_agent" && item.state !== "merge_queue"
          ? `Back with the agent after ${outcome.reason === "conflict" ? "a branch update conflicted" : "CI failed"}.`
          : item.state === "merge_queue"
            ? "Waiting to merge."
            : item.mergeQueue?.rechecking
              ? "Re-checking, keeps its place in the merge queue."
              : item.pr
                ? "Not in the merge queue yet."
                : "";
  const pr = item.pr
    ? `<a href="${esc(item.pr.url)}" target="_blank" rel="noopener noreferrer">Pull request #${item.pr.number}</a>`
    : "";
  const steps = entry?.steps.length
    ? `<ol class="merge-steps" role="list">${entry.steps.map((step) => `<li>${statePill(step.state, step.name)}${step.detail ? `<span class="muted">${esc(step.detail)}</span>` : ""}</li>`).join("")}</ol>`
    : "";
  const notices = mergeQueueNotice(item) + githubQueueNotice(item) + steps;
  if (!notices && (item.state === "merged" || !item.pr)) return "";
  return `<section class="issue-merge" aria-labelledby="merge-heading"><div class="flex flex-wrap items-center gap-2"><h2 id="merge-heading">Pull request and merge</h2>${item.pr ? `<span class="lin-id">#${item.pr.number}</span>` : ""}</div>
    ${pr || state ? `<p>${pr}${pr && state ? " · " : ""}${esc(state)}</p>` : ""}
    ${notices}</section>`;
}

/** CI reads that failed on the pull request, and what Paws did next. */
function fixRounds(
  snapshot: IssueDetailResponse,
  item: StatusItem,
  run: StatusRun | undefined,
): string {
  const rounds = snapshot.ciRounds.filter(
    (round) =>
      round.itemId === item.id &&
      (round.runId === null || run === undefined || inRun(run, round.runId)),
  );
  if (!rounds.length) return "";
  const next = (round: (typeof rounds)[number]) =>
    round.next === "agent"
      ? `fix ${round.fix ?? "?"} of ${round.fixLimit} sent to the agent`
      : round.next === "asked"
        ? "asked in Linear"
        : "stopped";
  return `<section class="fix-rounds" aria-labelledby="fix-rounds-heading"><h2 id="fix-rounds-heading">Fix rounds</h2><ol class="issue-items" role="list">${rounds
    .map((round) => {
      const failed = round.checks.filter((check) => check.state === "failed");
      return `<li><div><b>CI round ${round.round}</b> on <span class="mono">${esc(round.head.slice(0, 7))}</span> · ${esc(next(round))} · <span class="muted">${esc(clock24(round.recordedAt))}</span></div>${failed.length ? `<div class="row wrap">${failed.map((check) => (check.url ? `<a href="${esc(check.url)}" target="_blank" rel="noopener noreferrer">${esc(check.name)}</a>` : `<span>${esc(check.name)}</span>`)).join("")}</div>` : ""}</li>`;
    })
    .join("")}</ol></section>`;
}

function activityLog(key: string, run: StatusRun): string {
  return `<div class="log" data-log="${esc(key)}" data-follow="">${run.activity.map((line) => `<div class="ln ${esc(line.kind)}"><span class="ts">${esc(clock(line.at))}</span><span class="ty">${esc(line.kind)}</span><span class="tx">${esc(plainTask(line.text))}</span></div>`).join("")}</div>`;
}

/** The run of this attempt. An issue delegated twice has one run per Linear session. */
function itemRun(
  snapshot: IssueDetailResponse,
  item: StatusItem,
  others: readonly StatusItem[],
): StatusRun | undefined {
  if (item.runId) {
    const linked = snapshot.runs.find((run) => run.id === item.runId || inRun(run, item.runId!));
    if (linked) return linked;
  }
  const claimed = new Set(others.flatMap((other) => (other.runId ? [other.runId] : [])));
  return snapshot.runs
    .filter((run) => run.itemId === item.id && !claimed.has(run.id))
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
}

function attemptVerdict(
  snapshot: IssueDetailResponse,
  item: StatusItem,
  run: StatusRun | undefined,
): StatusVerdict | undefined {
  const verdicts = snapshot.verdicts.filter((entry) => entry.itemId === item.id);
  if (run === undefined) return verdicts.find((entry) => entry.runId === undefined);
  return verdicts.find((entry) =>
    entry.runId === undefined ? true : entry.runId === run.id || inRun(run, entry.runId),
  );
}

function inRun(run: StatusRun, id: string): boolean {
  return run.id === id || (run.attempts?.includes(id) ?? false);
}

/** `PAS-367-01M5…` is Paws's internal path id. People only see `PAS-367`. */
export function plainTask(text: string): string {
  return text.replace(/\b([A-Z][A-Z0-9]*-\d+)-[0-9A-HJKMNP-TV-Z]{26}\b/g, "$1");
}

const HOOK_EVENTS: Record<string, string> = {
  after_edit: "After a file edit",
  before_shell: "Before a shell command",
  before_tool: "Before a tool call",
  stop: "When the agent stops",
  session_start: "When a session starts",
};

export function runSetupSection(setup: StatusRunSetup): string {
  const skills = setup.skills.length
    ? `<ul class="run-setup-list" role="list" aria-label="Skills">${setup.skills
        .map(
          (skill) =>
            `<li class="run-setup-item"><b>${esc(skill.name)}</b><span class="mono" title="${esc(skill.version)}">${esc(skillVersionLabel(skill.version))}</span>${skill.installing ? '<span class="run-setup-note"><span class="tag running">Was installing</span><span class="muted">The run may have had the earlier version.</span></span>' : ""}</li>`,
        )
        .join("")}</ul>`
    : '<p class="muted">No registered skills.</p>';
  const hooks = setup.hooks.length
    ? `<ul class="run-setup-list" role="list" aria-label="Hooks">${setup.hooks
        .map(
          (hook) =>
            `<li class="run-setup-item"><b>${esc(hook.name)}</b><span class="muted">${esc(HOOK_EVENTS[hook.event] ?? hook.event)}</span></li>`,
        )
        .join("")}</ul>`
    : '<p class="muted">No hooks.</p>';
  return `<section class="run-setup" aria-labelledby="setup-heading"><h3 id="setup-heading">Skills and hooks</h3><div class="run-setup-group"><h4>Skills</h4>${skills}</div><div class="run-setup-group"><h4>Hooks</h4>${hooks}</div></section>`;
}

/** The client asks which controls apply; `data-version` and `data-no-controls` spare that question. */
function executionControls(item: StatusItem, run: StatusRun): string {
  return `<div id="execution-controls" data-item="${esc(run.itemId)}"${item.version === undefined ? "" : ` data-version="${item.version}"`}${item.noControls ? ' data-no-controls=""' : ""} hidden></div>`;
}

/** The run waits for its agent's usage limit to reset. Resume now and Stop sit beside the heading. */
function usagePauseSection(item: StatusItem, run: StatusRun, pause: StatusUsagePause): string {
  const at = utcClock(pause.resumeAt);
  return `<section class="usage-pause" aria-labelledby="usage-pause-heading">
    <div class="between"><h2 id="usage-pause-heading">Paused</h2>${executionControls(item, run)}</div>
    <div class="closeout-result usage-pause-card"><span class="result-icon" aria-hidden="true">II</span><div class="min-w-0"><p><b>${esc(pause.agent)} usage limit reached; resumes at ${esc(pause.resumeAt.slice(0, 10))} ${esc(at)} UTC.</b></p><p>The work so far is kept: branch, worktree and the agent conversation. At ${esc(at)} Paws continues the item${run.runner ? ` on runner ${esc(run.runner)}` : ""}.</p></div></div>
  </section>`;
}

function hostDiskFullNotice(item: StatusItem): string {
  if (!item.hostDiskFull) return "";
  return `<section class="closeout-result blocked" aria-labelledby="disk-${esc(item.id)}" data-host-disk-full><span class="result-icon" aria-hidden="true">!</span><div><h3 id="disk-${esc(item.id)}">${esc(item.hostDiskFull)}</h3><p>Paws retries when space is free.</p></div></section>`;
}

/** Where a queued item stands while every runner slot is busy. */
function queueNotice(item: StatusItem, generatedAt: string): string {
  if (item.state !== "queued") return "";
  const held = heldLine(item);
  const check = blockerCheck(item, generatedAt);
  if (!item.queue)
    return held
      ? `<section class="closeout-result queue-notice" aria-labelledby="queue-${esc(item.id)}"><span class="result-icon" aria-hidden="true">II</span><div><h3 id="queue-${esc(item.id)}">${esc(held)}</h3><p>It holds no runner slot while it waits.</p>${check}</div></section>`
      : "";
  return `<section class="closeout-result queue-notice" aria-labelledby="queue-${esc(item.id)}"><span class="result-icon" aria-hidden="true">${item.queue.position}</span><div><h3 id="queue-${esc(item.id)}">${esc(queueLine(item.queue))}</h3><p>${esc(item.queue.ownerCap ? `Waiting: ${capLine(item, item.queue.ownerCap)}. Paws starts ${item.id} when one of them finishes.` : `${held ? `${held}. ` : ""}Paws starts ${item.id} when a slot frees.`)} It holds no runner slot while it waits.</p>${check}</div></section>`;
}

function blockerCheck(item: StatusItem, generatedAt: string): string {
  if (item.held?.reason !== "blocked") return "";
  const checked = item.held.checkedAt
    ? `Blockers last checked ${ago(item.held.checkedAt, generatedAt)}`
    : "Blockers not checked yet";
  return `<div id="blocker-check" class="row wrap"><span class="muted" data-blocker-checked>${esc(`${checked}; checked every minute while blocked, every 5 minutes while Linear's request budget is low.`)}</span><button class="btn sm" type="button" data-check-blockers="${esc(item.id)}" hidden>Check blockers now</button><span class="muted" role="status" data-blocker-message></span></div>`;
}

/** Where an item stands in its repository's merge queue. Only the first ready one moves. */
function mergeQueueNotice(item: StatusItem): string {
  const queue =
    item.state === "merge_queue" || (item.state === "verifying" && item.mergeQueue?.rechecking)
      ? item.mergeQueue
      : undefined;
  if (!queue) return "";
  const detail = queue.rechecking
    ? "Re-checking, keeps its place. Closeout runs again on this pull request; the ready ones behind it merge meanwhile, and it merges next once Closeout accepts it."
    : queue.position === 1 || queue.ahead === null
      ? "This pull request moves now: Paws updates its branch onto main if main moved, waits for CI on that commit, and merges it."
      : `${queue.ahead} merges first. When this one's turn comes, Paws updates its branch onto main if main moved and waits for CI.`;
  return `<section class="closeout-result queue-notice" aria-labelledby="merge-queue-${esc(item.id)}"><span class="result-icon" aria-hidden="true">${queue.position}</span><div><h3 id="merge-queue-${esc(item.id)}">${esc(mergeQueueLine(queue))}</h3><p>${esc(detail)}</p></div></section>`;
}

/** Where the item's pull request stands in its repository's GitHub merge queue. */
function githubQueueNotice(item: StatusItem): string {
  if (item.state !== "merge_queue" || !item.githubQueue) return "";
  const queue = item.githubQueue;
  return `<section class="closeout-result queue-notice" aria-labelledby="github-queue-${esc(item.id)}"><span class="result-icon" aria-hidden="true">${queue.position ?? "–"}</span><div><h3 id="github-queue-${esc(item.id)}">${esc(queue.line)}</h3><p>GitHub updates, batches and tests this pull request with the others in its merge queue. Paws does not rebase it or run Closeout again.</p></div></section>`;
}

/** The transcript and the run's own links, as one row of buttons above the log. */
function activityActions(transcriptHref: string | null, links: StatusLink[]): string {
  const transcript =
    transcriptHref === null
      ? ""
      : `<a class="btn" href="${esc(transcriptHref)}" target="_blank" rel="noopener">Open full agent transcript</a>`;
  const buttons = transcript + linkButtons(links);
  return buttons ? `<div class="row wrap">${buttons}</div>` : "";
}

function pageHeading(view: Route["view"]): string {
  return `<h1 class="sr-only">${PAGES[view].title}</h1>`;
}

function entityPicker(
  label: string,
  choices: { value: string; label: string }[],
  selected: string,
): string {
  if (!choices.length) return "";
  return `<label class="entity-picker"><span>${label}</span><select data-route-picker aria-label="${label}">${selected ? "" : '<option value="">Choose a result</option>'}${choices.map((choice) => `<option value="${esc(choice.value)}"${choice.value === selected ? " selected" : ""}>${esc(choice.label)}</option>`).join("")}</select></label>`;
}
