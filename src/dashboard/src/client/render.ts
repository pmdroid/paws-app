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
import { renderPushOutages } from "./push-outage";
import { renderPolicyRunnerWarnings } from "./policy-runners";
import { itemAge, itemAgeLine, mergedTimesSection, stateTimeBar } from "./state-times";
import {
  doingLabel,
  doingTimeLine,
  issueTimeLine,
  itemPill,
  itemTime,
  PREPARING_LABEL,
} from "./doing";
import { JOURNEY_ORDER, journey, journeyPill, journeyStepper } from "./journey";
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
            : model.route.view === "settings"
              ? renderSettingsPage(model.route.page)
              : model.route.view === "questions"
                ? renderQuestions({
                    selected: model.route.id,
                    list: model.questions ?? null,
                    detail: model.question?.question.id === model.route.id ? model.question : null,
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
const RECENTLY_MERGED = 5;

function viewOverview(overview: OverviewResponse): string {
  const warnings = `${renderPushOutages(overview)}${renderPolicyRunnerWarnings(overview)}`;
  const intake = renderIntake(overview);
  if (!overview.issues.length && !overview.questions.length)
    return `${pageHeading("overview")}${warnings}${intake}<div class="empty">${esc(EMPTY_ISSUES)}</div>`;
  const attention = needsYou(overview);
  const asked = new Set(attention.map((entry) => entry.itemId));
  const now = Date.parse(overview.generatedAt);
  const open = overview.issues
    .filter((item) => !asked.has(item.id) && !DONE_STATES.includes(item.state))
    .map((item) => ({
      item,
      phase: journey(item, item.run ?? undefined, item.verdict ?? undefined),
    }));
  const queued = open.filter((entry) => entry.phase.step === "queued");
  const active = open
    .filter((entry) => entry.phase.step !== "queued")
    .sort(
      (left, right) =>
        JOURNEY_ORDER.indexOf(left.phase.step) - JOURNEY_ORDER.indexOf(right.phase.step),
    );
  const merged = overview.issues
    .filter((item) => item.state === "merged")
    .map((item) => ({ item, at: mergedAt(item) }))
    .sort((left, right) => right.at.localeCompare(left.at))
    .slice(0, RECENTLY_MERGED);
  const count = (value: number) => ` <span class="cnt">${value}</span>`;
  return `${pageHeading("overview")}${warnings}
    <div class="overview-grid"><div class="overview-column">
    <section class="overview-section" aria-labelledby="attention-heading"><h2 id="attention-heading">Needs you${count(attention.length)}</h2>
      ${attention.length ? `<ul class="overview-work" role="list">${attention.map((entry) => `<li class="overview-row" data-item="${esc(entry.itemId)}"><div class="overview-copy"><div><span class="lin-id">${esc(entry.itemId)}</span> <b>${esc(entry.title)}</b></div><p class="muted">${esc(entry.reason)}</p>${ageOf(overview, entry.itemId)}</div><a class="btn${entry.primary ? " primary" : ""}" href="${entry.href}" aria-label="${esc(`${entry.action}: ${entry.itemId}`)}">${esc(entry.action)}</a></li>`).join("")}</ul>` : '<p class="muted">Nothing needs your attention.</p>'}
    </section>
    <section class="overview-section" aria-labelledby="work-heading"><div class="between"><h2 id="work-heading">In progress${count(active.length)}</h2><a href="${routeHref({ view: "issues", id: null })}">All issues</a></div>
      ${
        active.length
          ? `<ul class="overview-work" role="list">${active.map(({ item, phase }) => workRow(item, phase.reason, journeyPill(phase), now)).join("")}</ul>`
          : '<p class="muted">No work is running right now.</p>'
      }
    </section></div><div class="overview-column">
    <section class="overview-section" aria-labelledby="queued-heading"><h2 id="queued-heading">Queued${count(queued.length)}</h2>
      ${
        queued.length
          ? `<ul class="overview-work" role="list">${queued.map(({ item, phase }) => workRow(item, waitingFor(item) ?? phase.reason, "", now)).join("")}</ul>`
          : '<p class="muted">Nothing is waiting for a runner.</p>'
      }
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
    </div></div>`;
}

function workRow(item: OverviewIssue, reason: string, pill: string, now: number): string {
  const runners = item.doing?.runners.join(", ") ?? "";
  const facts = [
    item.doing?.stalled ? "No live work for 30 min" : "",
    runners && !reason.includes(runners) ? `on ${runners}` : "",
    doingTimeLine(item, now) ?? itemAgeLine(item) ?? "",
  ].filter(Boolean);
  return `<li class="work-row" data-item="${esc(item.id)}"><a class="work-title" href="${routeHref({ view: "issues", id: item.id })}"><span class="lin-id">${esc(item.id)}</span> <b>${esc(item.title)}</b></a>${pill}<p class="work-facts"><span>${esc(reason)}</span>${facts.length ? `<span class="muted" data-item-time>${esc(facts.join(" · "))}</span>` : ""}</p></li>`;
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
    <ul class="issue-list" role="list">${list.issues.map((item) => issueRow(list.generatedAt, item)).join("")}</ul>
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
  return `<li class="issue-row" data-issue-state="${issueBucket(item)}" data-issue-id="${esc(item.id)}" data-issue-project="${esc(item.project?.id ?? NO_PROJECT_FILTER)}"><a class="work-title" href="${routeHref({ view: "issues", id: item.id })}"><span class="lin-id">${esc(item.id)}</span> <b>${esc(item.title)}</b></a>${itemPill(item)}<div class="issue-facts">${issueMeta(item)}${itemTime(item, Date.parse(generatedAt))}${reason ? `<span class="muted" data-wait-reason>${esc(reason)}</span>` : ""}</div></li>`;
}

function issueMeta(item: StatusItem): string {
  const facts = [item.owner, item.project?.name ?? "Solo"].filter(Boolean);
  return `<span class="muted">${esc(facts.join(" · "))}</span>`;
}

function issueBucket(item: StatusItem): "needs" | "done" | "active" {
  if (["needs_human", "awaiting_input"].includes(item.state)) return "needs";
  if (item.state === "merged" || item.state === "completed") return "done";
  return "active";
}

function relatedIssues(ids: readonly string[]): string {
  return `<div class="row wrap">${ids.map((id) => `<a href="${routeHref({ view: "issues", id })}">${esc(id)}</a>`).join("")}</div>`;
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
    <header class="run-heading"><div class="row wrap">${journeyPill(now)}<span class="mono muted min-w-0"${item.branch ? ` title="${esc(`Branch ${item.branch}`)}"` : ""}>${esc(snapshot.project.repo)}</span>${time ? `<span class="muted" data-item-now>${esc(time)}</span>` : ""}</div>
      <h1><span class="lin-id">${esc(item.id)}</span> ${esc(item.title)}</h1>
      ${issueFacts(snapshot, item, run, blocked)}
      ${item.links.length ? `<div class="row wrap">${linkButtons(item.links)}</div>` : ""}
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
    ${run ? (run.usagePause ? usagePauseSection(item, run, run.usagePause) : executionControls(item, run)) : ""}
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
): string {
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
  if (item.blockers.length) facts.push(["Blocked by", relatedIssues(item.blockers)]);
  if (blocked.length) facts.push(["Blocks", relatedIssues(blocked)]);
  if (item.session) {
    const link = `<a href="${esc(item.session.url)}" target="_blank" rel="noopener noreferrer">Linear session</a>`;
    facts.push([
      "Session",
      item.session.shared.length
        ? `${link} shared with ${item.session.shared.map((other) => `<a class="lin-id" href="${routeHref({ view: "issues", id: other })}">${esc(other)}</a>`).join(", ")}`
        : link,
    ]);
  }
  return factList(facts);
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

function timelineMove(from: string, to: string): string {
  return `<p class="timeline-move">${plainWords(from)} <span aria-hidden="true">→</span><span class="sr-only">to</span> <strong>${plainWords(to)}</strong></p>`;
}

function timelineTime(at: string): string {
  return `<time datetime="${esc(at)}" title="${esc(at)}">${esc(clock24(at))}</time>`;
}

function timelineLoop(group: readonly StatusItemEvent[]): string {
  const [first, second] = group as [StatusItemEvent, StatusItemEvent];
  const last = group.at(-1)!;
  return `<li data-kind="loop"><span class="timeline-time">${timelineTime(first.at)}–${timelineTime(last.at)}</span><span class="timeline-dot" data-state="${esc(first.to)}" aria-hidden="true"></span><div class="timeline-body"><p class="timeline-move"><strong>${plainWords(first.to)}</strong> and back to ${plainWords(second.to)} <span class="tag">${group.length / 2} times</span></p><p class="muted">${plainWords(first.event)} · ${plainWords(second.event)}</p></div></li>`;
}

function ciRerunEntry(entry: StatusItemEvent): string {
  const runs = entry.runIds?.length
    ? `workflow run ${entry.runIds.map((id) => esc(String(id))).join(", ")}`
    : "";
  return `<li data-kind="ci_rerun"><span class="timeline-time">${timelineTime(entry.at)}</span><span class="timeline-dot" data-state="${esc(entry.to)}" aria-hidden="true"></span><div class="timeline-body"><p class="timeline-move"><strong>CI re-run</strong></p><p class="timeline-why">CI re-run requested by the agent: ${esc(entry.reason ?? "")}</p>${runs ? `<p class="muted">${runs}</p>` : ""}</div></li>`;
}

function itemTimelineEntry(entry: StatusItemEvent): string {
  if (entry.kind === "ci_rerun") return ciRerunEntry(entry);
  const why =
    entry.kind === "restart"
      ? `Back to the agent for ${esc(RESTART_REASON_LABELS[entry.reason ?? ""] ?? (entry.reason ?? "a restart").replaceAll("_", " "))}.`
      : entry.kind === "ask"
        ? `Asked a person: ${plainWords(entry.reason ?? "a question")}.`
        : "";
  const detail = [plainWords(entry.event), entry.actor ? `by ${esc(entry.actor)}` : ""]
    .filter(Boolean)
    .join(" · ");
  return `<li data-kind="${entry.kind}"><span class="timeline-time">${timelineTime(entry.at)}</span><span class="timeline-dot" data-state="${esc(entry.to)}" aria-hidden="true"></span><div class="timeline-body">${timelineMove(entry.from, entry.to)}${why ? `<p class="timeline-why">${why}</p>` : ""}<p class="muted">${detail}</p></div></li>`;
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
  return `<section class="issue-merge" aria-labelledby="merge-heading"><h2 id="merge-heading">Pull request and merge</h2>
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
    <div class="closeout-result usage-pause-card"><span class="result-icon" aria-hidden="true">II</span><div class="min-w-0"><p><b>${esc(pause.agent)} reached its usage limit. Paws continues at ${esc(at)} UTC.</b></p><p>The work so far is kept: branch, worktree and the agent conversation. At ${esc(at)} Paws continues the item${run.runner ? ` on runner ${esc(run.runner)}` : ""}.</p></div></div>
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
