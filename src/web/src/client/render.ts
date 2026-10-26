import { SETTINGS_PAGES, renderSettingsPage } from "./settings-pages";
import type {
  StatusAgentCloseout,
  StatusItem,
  StatusItemDetail,
  StatusItemEvent,
  StatusLink,
  StatusQuestion,
  StatusRun,
  StatusRunSetup,
  StatusSnapshot,
  StatusUsagePause,
  StatusVerdict,
} from "../contract";
import {
  agentChip,
  ago,
  avatar,
  clock,
  clock24,
  esc,
  itemLabel,
  linkButtons,
  linkList,
  mergeQueueLine,
  queueLine,
  capLine,
  heldLine,
  waitReason,
  runLabel,
  skillVersionLabel,
  PHASE_NAMES,
  statePill,
  taskPhase,
  utcClock,
} from "./format";
import { needsSnapshot, routeHref, type Route } from "./route";
import { parseEngineUrl } from "./format";
import { emptyCloseoutView, renderCloseoutChecks, type CloseoutView } from "./closeout";
import { agentProgress, findAgentCloseout, renderAgentCloseout } from "./agent-closeout";
import { evidenceSlot, renderEvidencePage, type MediaInfo } from "./evidence";
import { PAGES } from "./navigation";
import { renderMergeQueue } from "./merge-queue";
import { renderIntake } from "./intake";
import { deadDeliveriesSection } from "./dead-deliveries";
import { visualReviewSection, waitingVisualReview } from "./visual-review";
import { LINK_ASK_ACTIONS, LINK_ASK_ANCHORS, linkAskCard } from "./link-ask";

export interface RenderModel {
  route: Route;
  phase: "loading" | "ready" | "error";
  snapshot: StatusSnapshot | null;
  /** The open issue page's own data from `GET /api/status/items/<id>`. It renders that page alone. */
  detail?: StatusItemDetail | null;
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

const IMPLEMENTING = new Set(["queued", "planning", "running", "awaiting_input"]);

export function render(model: RenderModel): Rendered {
  const snapshot = model.snapshot;
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
      model.route.view === "runners"
        ? '<div id="runner-settings"></div>'
        : model.route.view === "settings"
          ? renderSettingsPage(model.route.page)
          : model.phase !== "loading" && openDetail(model)
            ? issuePage(
                model.detail!,
                model.detail!.id,
                model.closeout ?? emptyCloseoutView(),
                model.engineUrl,
              )
            : snapshot && model.phase !== "loading"
              ? renderView(snapshot, model)
              : renderPending(model),
    title,
  };
}

/** The issue page has its detail; the list snapshot is not read for it. */
export function openDetail(model: Pick<RenderModel, "route" | "detail">): boolean {
  return (
    model.route.view === "issues" && model.route.id !== null && model.detail?.id === model.route.id
  );
}

function renderTop(_model: RenderModel): string {
  return "";
}

function renderBanner(model: RenderModel): string {
  if (model.phase === "error" && needsSnapshot(model.route)) {
    return `<div class="err-bar" role="status"><span class="n">Offline</span><span>${esc(model.error ?? "Could not load status")}.${model.snapshot ? " Showing the last snapshot." : ""}</span></div>`;
  }
  return "";
}

function renderPending(model: RenderModel): string {
  if (model.phase === "error") {
    return `${pageHeading(model.route.view)}<div class="empty"><div>Status unavailable</div>${esc(model.error ?? "The engine did not return a snapshot.")}<div><button class="btn primary" type="button" data-action="refresh">Retry</button></div></div>`;
  }
  return `${pageHeading(model.route.view)}<div class="empty" role="status">Loading status…</div>`;
}

function renderView(snapshot: StatusSnapshot, model: RenderModel): string {
  switch (model.route.view) {
    case "overview":
      return viewOverview(snapshot);
    case "issues":
      return viewIssues(
        snapshot,
        model.route.id,
        model.closeout ?? emptyCloseoutView(),
        model.engineUrl,
      );
    case "runs":
      return viewRuns(
        snapshot,
        model.route.id,
        model.closeout ?? emptyCloseoutView(),
        model.engineUrl,
      );
    case "mergeQueue":
      return `${pageHeading("mergeQueue")}${renderMergeQueue(snapshot)}`;
    case "questions":
      return viewQuestions(snapshot, model.route.id);
    case "evidence":
      return renderEvidencePage(
        snapshot,
        model.route.id,
        model.mediaInfo ?? new Map(),
        model.engineUrl,
      );
    case "runners":
      return '<div id="runner-settings"></div>';
    case "settings":
      return renderSettingsPage(model.route.page);
  }
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

function viewOverview(snapshot: StatusSnapshot): string {
  const intake = renderIntake(snapshot);
  if (!snapshot.items.length && !snapshot.questions.length)
    return `${pageHeading("overview")}${intake}<div class="empty">${esc(EMPTY_ISSUES)}</div>`;
  const runs = new Map(snapshot.runs.map((run) => [run.id, run]));
  const attention = snapshot.items.flatMap((item): NeedsYou[] => {
    const run = item.runId ? runs.get(item.runId) : undefined;
    const question = snapshot.questions.find((entry) => entry.itemId === item.id);
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
    if (["merged", "completed", "stopped"].includes(item.state)) return [];
    const verdict = itemVerdict(snapshot, item.id);
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
  for (const question of snapshot.questions) {
    if (snapshot.items.some((item) => item.id === question.itemId)) continue;
    attention.push({
      itemId: question.itemId,
      title: question.title,
      reason: "Waiting for your answer.",
      action: "Answer question",
      href: routeHref({ view: "questions", id: question.id }),
    });
  }
  const needsYou = new Set(attention.map((entry) => entry.itemId));
  const work = snapshot.items.filter((item) => {
    const run = item.runId ? runs.get(item.runId) : undefined;
    return (
      !needsYou.has(item.id) &&
      ["planning", "running", "verifying"].includes(item.state) &&
      (!run || ["running", "verifying"].includes(run.state)) &&
      !item.blockers.length
    );
  });
  const queued = snapshot.items.filter((item) => item.state === "queued").length;
  const merging = snapshot.items.filter((item) => item.state === "merge_queue").length;
  const summary = [
    `${attention.length} need${attention.length === 1 ? "s" : ""} you`,
    `${work.length} working`,
    ...(queued ? [`${queued} queued`] : []),
    ...(merging ? [`${merging} waiting to merge`] : []),
  ].join(" · ");
  return `${pageHeading("overview")}
    <div class="between"><p class="overview-summary">${esc(summary)}</p><a href="${routeHref({ view: "issues", id: null })}">All issues</a></div>
    <section class="overview-section" aria-labelledby="attention-heading"><h2 id="attention-heading">Needs you</h2>
      ${attention.length ? `<ul class="overview-work" role="list">${attention.map((entry) => `<li class="overview-row"><div class="overview-copy"><div><span class="lin-id">${esc(entry.itemId)}</span> <b>${esc(entry.title)}</b></div><p class="muted">${esc(entry.reason)}</p></div><a class="btn${entry.primary ? " primary" : ""}" href="${entry.href}" aria-label="${esc(`${entry.action}: ${entry.itemId}`)}">${esc(entry.action)}</a></li>`).join("")}</ul>` : '<p class="muted">Nothing needs your attention.</p>'}
    </section>
    ${intake}
    <section class="overview-section" aria-labelledby="work-heading"><h2 id="work-heading">Working now</h2>
      ${
        work.length
          ? `<ul class="overview-work" role="list">${work
              .slice(0, 6)
              .map((item) => {
                const href = routeHref({ view: "issues", id: item.id });
                return `<li class="overview-row"><a class="work-title" href="${href}"><span class="lin-id">${esc(item.id)}</span> <b>${esc(item.title)}</b></a>${statePill(item.state, itemLabel(item.state))}</li>`;
              })
              .join(
                "",
              )}</ul>${work.length > 6 ? `<a href="${routeHref({ view: "issues", id: null })}">View all ${work.length} working issues</a>` : ""}`
          : '<p class="muted">No work is running right now.</p>'
      }
    </section>`;
}

const EMPTY_ISSUES = "No issues yet. Delegate an issue to Paws in Linear.";

function viewIssues(
  snapshot: StatusSnapshot,
  id: string | null,
  closeout: CloseoutView,
  engineUrl: string | null,
): string {
  const selected = id ? findItem(snapshot, id) : undefined;
  if (id && !selected)
    return `${pageHeading("issues")}<div class="empty">Issue not found. Choose an issue from the list.</div>${entityPicker(
      "Issue",
      snapshot.items.map((item) => ({
        value: routeHref({ view: "issues", id: item.id }),
        label: `${item.id} · ${item.title}`,
      })),
      "",
    )}`;
  if (selected) return issuePage(snapshot, selected.id, closeout, engineUrl);
  if (!snapshot.items.length)
    return `${pageHeading("issues")}<div class="empty">${esc(EMPTY_ISSUES)}</div>`;
  return `${pageHeading("issues")}
    <div class="issue-filters" role="group" aria-label="Filter issues">
      <button type="button" class="btn on" data-action="issue-filter" data-issue-filter="all" aria-pressed="true">All</button>
      <button type="button" class="btn" data-action="issue-filter" data-issue-filter="active" aria-pressed="false">Active</button>
      <button type="button" class="btn" data-action="issue-filter" data-issue-filter="needs" aria-pressed="false">Needs attention</button>
      <button type="button" class="btn" data-action="issue-filter" data-issue-filter="done" aria-pressed="false">Done</button>
    </div>
    ${projectFilter(snapshot.items)}
    <ul class="issue-list" role="list">${snapshot.items.map((item) => issueRow(snapshot, item)).join("")}</ul>
    <p class="empty issue-filter-empty" hidden>No issues match this filter.</p>`;
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

function issueRow(snapshot: StatusSnapshot, item: StatusItem): string {
  const blockers = item.blockers;
  const reason = waitReason(item) ?? (blockers.length ? `Blocked by ${blockers.join(", ")}` : null);
  return `<li class="issue-row" data-issue-state="${issueBucket(item)}" data-issue-id="${esc(item.id)}" data-issue-project="${esc(item.project?.id ?? NO_PROJECT_FILTER)}"><a class="work-title" href="${routeHref({ view: "issues", id: item.id })}"><span class="lin-id">${esc(item.id)}</span> <b>${esc(item.title)}</b></a>${statePill(item.state, itemLabel(item.state))}<div class="issue-facts">${issueMeta(item)}${reason ? `<span class="muted" data-wait-reason>${esc(reason)}</span>` : ""}</div></li>`;
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
  if (!ids.length) return `<p class="muted">None.</p>`;
  return `<div class="row wrap">${ids.map((id) => `<a href="${routeHref({ view: "issues", id })}">${esc(id)}</a>`).join("")}</div>`;
}

function viewRuns(
  snapshot: StatusSnapshot,
  id: string | null,
  closeout: CloseoutView,
  engineUrl: string | null,
): string {
  const run = id === null ? undefined : snapshot.runs.find((entry) => inRun(entry, id));
  if (run && findItem(snapshot, run.itemId))
    return issuePage(snapshot, run.itemId, closeout, engineUrl);
  return viewIssues(snapshot, id, closeout, engineUrl);
}

/**
 * Everything about one issue: its state, the timeline of every engine run, Closeout, reviews,
 * questions, fix rounds, the pull request and merge, and earlier Linear sessions further down.
 */
function issuePage(
  snapshot: StatusSnapshot,
  id: string,
  closeout: CloseoutView,
  engineUrl: string | null,
): string {
  const attempts = snapshot.items.filter((entry) => entry.id === id);
  const item = attempts.find((entry) => !entry.endedAt) ?? attempts[0]!;
  const earlier = attempts
    .filter((entry) => entry !== item)
    .sort((left, right) => (right.endedAt ?? "").localeCompare(left.endedAt ?? ""));
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
    run === undefined ? null : `/status/runs/${encodeURIComponent(run.id)}/transcript`;
  const transcriptHref =
    transcriptPath === null || snapshot.source !== "live"
      ? null
      : engine === null
        ? transcriptPath
        : new URL(transcriptPath, engine).href;
  const blocked =
    "blocks" in snapshot
      ? (snapshot as StatusItemDetail).blocks
      : snapshot.items
          .filter((entry) => entry.id !== item.id && entry.blockers.includes(item.id))
          .map((entry) => entry.id);
  return `${pageHeading("issues")}<article class="run-page issue-page">
    <nav class="crumbs" aria-label="Breadcrumb"><a href="${routeHref({ view: "issues", id: null })}">Issues</a><span>/</span><span class="lin-id">${esc(item.id)}</span></nav>
    <header class="run-heading"><div class="row wrap">${run ? phasePill(item, run, verdict) : statePill(item.state, itemLabel(item.state))}<span class="mono muted min-w-0"${item.branch ? ` title="${esc(`Branch ${item.branch}`)}"` : ""}>${esc(snapshot.project.repo)}</span></div>
      <h1><span class="lin-id">${esc(item.id)}</span> ${esc(item.title)}</h1>
      ${issueFacts(snapshot, item, run)}
      ${item.links.length ? `<div class="row wrap">${linkButtons(item.links)}</div>` : ""}
    </header>
    ${run ? phaseStrip(item, run, verdict, agent) : ""}
    ${queueNotice(item)}
    ${deadDeliveriesSection(snapshot, item.id)}
    ${run ? (run.usagePause ? usagePauseSection(run, run.usagePause) : executionControls(run)) : ""}
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
    ${verdict ? `<section class="closeout-section" aria-label="Closeout">${renderCloseoutChecks(verdict, closeout, engineUrl, item.pr, item.state)}</section>` : ""}
    ${agent ? renderAgentCloseout(agent, closeout, engineUrl, verdict !== undefined && !IMPLEMENTING.has(item.state)) : ""}
    ${run ? evidenceSlot(snapshot, run.id) : ""}
    ${fixRounds(snapshot, item, run)}
    ${pullRequestSection(snapshot, item)}
    ${itemTimeline(item)}
    ${run?.setup ? runSetupSection(run.setup) : ""}
    ${
      run
        ? `<section class="run-activity" aria-labelledby="activity-heading"><h2 id="activity-heading">Timeline</h2>
      ${activityActions(transcriptHref, run.links)}
      ${activityLog(`activity-${run.id}`, run)}
    </section>`
        : `<p class="muted">No agent activity yet.</p>`
    }
    <section class="issue-relations" aria-label="Related issues"><h2>Blocked by</h2>${relatedIssues(item.blockers)}<h2>Blocks</h2>${relatedIssues(blocked)}</section>
    ${earlier.map((entry, index) => earlierAttempt(snapshot, entry, index, attempts)).join("")}
  </article>`;
}

/** State, project, runner and agent, and the Linear session it belongs to. */
function issueFacts(
  snapshot: StatusSnapshot,
  item: StatusItem,
  run: StatusRun | undefined,
): string {
  const facts: Array<[string, string]> = [
    ["State", esc(itemLabel(item.state))],
    ["Project", esc(item.project?.name ?? "No project")],
    ["Runner", esc(run?.runner ?? "Not placed yet")],
    ["Agent", esc(run?.agent ?? item.agent)],
  ];
  if (item.owner) facts.push(["Delegated by", esc(item.owner)]);
  if (run) facts.push(["Started", esc(ago(run.startedAt, snapshot.generatedAt))]);
  if (item.linearRequests !== undefined)
    facts.push(["Linear requests", String(item.linearRequests)]);
  if (item.session) {
    const link = `<a href="${esc(item.session.url)}" target="_blank" rel="noopener noreferrer">Linear session</a>`;
    facts.push([
      "Session",
      item.session.shared.length
        ? `${link} shared with ${item.session.shared.map((other) => `<a class="lin-id" href="${routeHref({ view: "issues", id: other })}">${esc(other)}</a>`).join(", ")}`
        : link,
    ]);
  }
  return `<dl class="issue-facts-grid">${facts.map(([term, value]) => `<div><dt>${term}</dt><dd>${value}</dd></div>`).join("")}</dl>`;
}

const RESTART_REASON_LABELS: Record<string, string> = {
  findings: "Closeout findings",
  ci: "failing CI",
  review: "review feedback",
  conflict: "a merge conflict",
  follow_up: "a follow-up in Linear",
  answer: "an answer",
};

/** Every committed state change of the item, oldest first, from `work_item_event`. */
function itemTimeline(item: StatusItem): string {
  if (!item.timeline?.length) return "";
  return `<section class="item-timeline" aria-labelledby="item-timeline-heading"><h2 id="item-timeline-heading">Item timeline</h2>
    <ol role="list">${item.timeline.map(itemTimelineEntry).join("")}</ol></section>`;
}

function itemTimelineEntry(entry: StatusItemEvent): string {
  const state = (value: string) => esc(value.replaceAll("_", " "));
  const why =
    entry.kind === "restart"
      ? `Back to the agent for ${esc(RESTART_REASON_LABELS[entry.reason ?? ""] ?? (entry.reason ?? "a restart").replaceAll("_", " "))}`
      : entry.kind === "ask"
        ? `Asked a person: ${esc((entry.reason ?? "a question").replaceAll("_", " "))}`
        : "";
  const detail = [
    `from ${state(entry.from)}`,
    esc(entry.event),
    entry.actor ? `by ${esc(entry.actor)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return `<li data-kind="${entry.kind}"><time datetime="${esc(entry.at)}" title="${esc(entry.at)}">${esc(clock24(entry.at))}</time> <strong>${state(entry.to)}</strong>${why ? ` ${why}.` : ""} <span class="muted">${detail}</span></li>`;
}

/** The pull request and where its merge stands. */
function pullRequestSection(snapshot: StatusSnapshot, item: StatusItem): string {
  const entry = snapshot.mergeQueue.find((candidate) => candidate.itemId === item.id);
  const outcome = snapshot.mergeHistory?.findLast((candidate) => candidate.itemId === item.id);
  const state =
    item.state === "merged"
      ? "Merged."
      : outcome?.outcome === "merged"
        ? `Merged at ${clock24(outcome.at)}.`
        : outcome?.outcome === "back_with_agent" && item.state !== "merge_queue"
          ? `Back with the agent after ${outcome.reason === "conflict" ? "a branch update conflicted" : "CI failed"}.`
          : item.state === "merge_queue"
            ? "Waiting to merge."
            : item.pr
              ? "Not in the merge queue yet."
              : "";
  const pr = item.pr
    ? `<a href="${esc(item.pr.url)}" target="_blank" rel="noopener noreferrer">Pull request #${item.pr.number}</a>`
    : "";
  const steps = entry?.steps.length
    ? `<ol class="merge-steps" role="list">${entry.steps.map((step) => `<li>${statePill(step.state, step.name)}${step.detail ? `<span class="muted">${esc(step.detail)}</span>` : ""}</li>`).join("")}</ol>`
    : "";
  return `<section class="issue-merge" aria-labelledby="merge-heading"><h2 id="merge-heading">Pull request and merge</h2>
    ${pr || state ? `<p>${pr}${pr && state ? " · " : ""}${esc(state)}</p>` : '<p class="muted">No pull request yet.</p>'}
    ${mergeQueueNotice(item)}${githubQueueNotice(item)}${steps}</section>`;
}

/** CI reads that failed on the pull request, and what Paws did next. */
function fixRounds(snapshot: StatusSnapshot, item: StatusItem, run: StatusRun | undefined): string {
  const rounds = (snapshot.ciRounds ?? []).filter(
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

/** A Linear session on this issue that a newer one replaced (re-delegation). */
function earlierAttempt(
  snapshot: StatusSnapshot,
  item: StatusItem,
  index: number,
  attempts: readonly StatusItem[],
): string {
  const run = itemRun(
    snapshot,
    item,
    attempts.filter((entry) => entry !== item),
  );
  const verdict = attemptVerdict(snapshot, item, run);
  const heading = `earlier-${index}`;
  const evidence = run ? (snapshot.evidence ?? []).filter((entry) => inRun(run, entry.runId)) : [];
  const facts = [
    itemLabel(item.state),
    ...(run ? [`${run.agent}${run.runner ? ` on runner ${run.runner}` : ""}`] : []),
    ...(verdict
      ? [`Closeout ${verdict.decision}, attempt ${verdict.attempt} of ${verdict.maxAttempts}`]
      : []),
  ];
  return `<section class="earlier-attempt" aria-labelledby="${heading}"><h2 id="${heading}">Earlier attempt${item.endedAt ? `, ended ${esc(clock24(item.endedAt))}` : ""}</h2>
    <p class="muted">${esc(facts.join(" · "))}</p>
    ${item.session ? `<p><a href="${esc(item.session.url)}" target="_blank" rel="noopener noreferrer">Linear session</a></p>` : ""}
    ${item.pr ? `<p><a href="${esc(item.pr.url)}" target="_blank" rel="noopener noreferrer">Pull request #${item.pr.number}</a></p>` : ""}
    ${evidence.length ? `<ul class="issue-items" role="list">${evidence.map((entry) => `<li><a href="${esc(routeHref({ view: "evidence", id: entry.id }))}">${esc(entry.displayName)}</a> <span class="muted">${esc(entry.checkId)} · attempt ${entry.attempt}</span></li>`).join("")}</ul>` : ""}
    ${run ? activityLog(`${heading}-${run.id}`, run) : ""}
  </section>`;
}

function activityLog(key: string, run: StatusRun): string {
  return `<div class="log" data-log="${esc(key)}" data-follow="">${run.activity.map((line) => `<div class="ln ${esc(line.kind)}"><span class="ts">${esc(clock(line.at))}</span><span class="ty">${esc(line.kind)}</span><span class="tx">${esc(plainTask(line.text))}</span></div>`).join("")}</div>`;
}

/** The run of this attempt. An issue delegated twice has one run per Linear session. */
function itemRun(
  snapshot: StatusSnapshot,
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
  snapshot: StatusSnapshot,
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
            `<li class="run-setup-item"><b>${esc(skill.name)}</b><span class="mono" title="${esc(skill.version)}">${esc(skillVersionLabel(skill.version))}</span>${skill.installing ? '<span class="tag running">Was installing</span><span class="muted">The run may have had the earlier version.</span>' : ""}</li>`,
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
  return `<section class="run-setup" aria-labelledby="setup-heading"><h2 id="setup-heading">Skills and hooks</h2><h3>Skills</h3>${skills}<h3>Hooks</h3>${hooks}</section>`;
}

function executionControls(run: StatusRun): string {
  return `<div id="execution-controls" data-item="${esc(run.itemId)}" hidden></div>`;
}

/** The run waits for its agent's usage limit to reset. Resume now and Stop sit beside the heading. */
function usagePauseSection(run: StatusRun, pause: StatusUsagePause): string {
  const at = utcClock(pause.resumeAt);
  return `<section class="usage-pause" aria-labelledby="usage-pause-heading">
    <div class="between"><h2 id="usage-pause-heading">Paused</h2>${executionControls(run)}</div>
    <div class="closeout-result usage-pause-card"><span class="result-icon" aria-hidden="true">II</span><div class="min-w-0"><p><b>${esc(pause.agent)} reached its usage limit. Paws continues at ${esc(at)} UTC.</b></p><p>The work so far is kept: branch, worktree and the agent conversation. At ${esc(at)} Paws continues the item${run.runner ? ` on runner ${esc(run.runner)}` : ""}.</p></div></div>
  </section>`;
}

/** Where a queued item stands while every runner slot is busy. */
function queueNotice(item: StatusItem): string {
  if (item.state !== "queued") return "";
  const held = heldLine(item);
  if (!item.queue)
    return held
      ? `<section class="closeout-result queue-notice" aria-labelledby="queue-${esc(item.id)}"><span class="result-icon" aria-hidden="true">II</span><div><h3 id="queue-${esc(item.id)}">${esc(held)}</h3><p>It holds no runner slot while it waits.</p></div></section>`
      : "";
  return `<section class="closeout-result queue-notice" aria-labelledby="queue-${esc(item.id)}"><span class="result-icon" aria-hidden="true">${item.queue.position}</span><div><h3 id="queue-${esc(item.id)}">${esc(queueLine(item.queue))}</h3><p>${esc(item.queue.ownerCap ? `Waiting: ${capLine(item, item.queue.ownerCap)}. Paws starts ${item.id} when one of them finishes.` : `${held ? `${held}. ` : ""}Paws starts ${item.id} when a slot frees.`)} It holds no runner slot while it waits.</p></div></section>`;
}

/** Where an item stands in its repository's merge queue. Only the first one moves. */
function mergeQueueNotice(item: StatusItem): string {
  const queue = item.state === "merge_queue" ? item.mergeQueue : undefined;
  if (!queue) return "";
  const detail =
    queue.position === 1
      ? "This pull request moves now: Paws updates its branch onto main if main moved, waits for CI on that commit, and merges it."
      : `${queue.ahead ?? "The item ahead"} merges first. When this one's turn comes, Paws updates its branch onto main if main moved and waits for CI.`;
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

function viewQuestions(snapshot: StatusSnapshot, id: string | null): string {
  const cards = snapshot.questions
    .map((question) => questionCard(snapshot, question, question.id === id))
    .join("");
  return `${pageHeading("questions")}
    ${cards || '<div class="empty">No open questions.</div>'}`;
}

function questionCard(
  snapshot: StatusSnapshot,
  question: StatusQuestion,
  highlight: boolean,
): string {
  const item = findItem(snapshot, question.itemId);
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
  return `<article class="q${highlight ? " hl" : ""}" id="q-${esc(question.id)}">
    <div class="qh">
      <div class="row wrap min-w-0"><span class="lin-id">${esc(question.id)}</span><span class="tag${question.kind === "exhausted" ? " bad" : ""}">${esc(question.kind)}</span><span class="tag">${esc(question.urgency)}</span>${itemLink(item)}${item ? agentChip(item.agent) : ""}</div>
      <div class="claim">${claimed}<span class="dim">${esc(ago(question.askedAt, snapshot.generatedAt))}</span></div>
      <div class="title min-w-0">${esc(question.title)}</div>
    </div>
    <div class="qb"><div class="muted">${esc(question.body)}</div>
      ${question.context ? `<div class="ctx">${esc(question.context)}</div>` : ""}
      ${options ? `<div class="opts">${options}</div>` : ""}
      <div class="row">${question.links.length ? linkList(question.links) : '<span class="dim">Answer in the source conversation to continue.</span>'}</div>
    </div></article>`;
}

function phaseStrip(
  item: StatusItem | undefined,
  run: StatusRun | undefined,
  verdict?: StatusVerdict,
  agent?: StatusAgentCloseout,
): string {
  const phase = taskPhase(item?.state ?? null, run?.state ?? "running", verdict?.decision);
  const paused = run?.usagePause ? `paused until ${utcClock(run.usagePause.resumeAt)}` : "";
  const names = PHASE_NAMES.map((name, index) =>
    paused && index === phase.current
      ? `${name} · ${paused}`
      : index === 0 && agent?.attempts.at(-1)?.checks.length
        ? `${name} · Agent Closeout ${agentProgress(agent)}`
        : index === 1 && verdict
          ? `${name} · ${verdict.attempt} of ${verdict.maxAttempts}`
          : index === 2 && item?.state === "merge_queue" && item.mergeQueue
            ? `${name} · #${item.mergeQueue.position} in queue`
            : name,
  );
  const steps = names.map((name, index) => {
    const failed =
      index === 1 && verdict && ["exhausted", "rejected", "blocked"].includes(verdict.decision);
    const cls = failed
      ? "failed"
      : index < phase.current || (index === 1 && verdict?.decision === "accepted")
        ? "done"
        : index === phase.current
          ? "now"
          : "wait";
    return { name, cls, current: index === phase.current };
  });
  const review = item?.visualReviews?.at(-1);
  const waiting = waitingVisualReview(item);
  if (review) {
    if (waiting) steps[0] = { ...steps[0]!, cls: "done", current: false };
    steps.splice(1, 0, {
      name: waiting ? `Visual review · round ${waiting.round}` : "Visual review",
      cls: waiting ? "now" : review.state === "accepted" || phase.current > 0 ? "done" : "wait",
      current: waiting !== undefined,
    });
  }
  const marks = steps
    .map(
      ({ name, cls, current }) =>
        `<li class="run-step ${cls}"${current ? ' aria-current="step"' : ""}>${cls === "done" ? "✓ " : cls === "failed" ? "✕ " : ""}${esc(name)}</li>`,
    )
    .join("");
  return `<ol class="run-stepper${review ? " with-review" : ""}" aria-label="Run progress" title="${esc(waiting ? "Waiting for a visual review. The item is not complete." : phase.detail)}">${marks}</ol>`;
}

function phasePill(item: StatusItem | undefined, run: StatusRun, verdict?: StatusVerdict): string {
  const recheck =
    verdict?.decision === "running" &&
    item?.state !== "running" &&
    item?.state !== "queued" &&
    item?.state !== "planning" &&
    item?.state !== "awaiting_input";
  if (item?.state === "completed") return statePill("completed", "Complete");
  if (item?.state === "merged") return statePill("merged", "Complete");
  if (run.usagePause) return statePill("running usage-limit", "Paused · usage limit");
  if (item?.state === "queued") return statePill("queued", "Queued");
  if (waitingVisualReview(item)) return statePill("awaiting_input", "Waiting for visual review");
  if (recheck) return statePill("verifying", "Closeout");
  if (verdict?.decision === "blocked") return statePill("needs_human", "Closeout blocked");
  if (verdict?.decision === "exhausted") return statePill("exhausted", "Closeout exhausted");
  if (verdict?.decision === "rejected") return statePill("stopped", "Closeout failed");
  if (item?.state === "needs_human") return statePill("needs_human", "Needs a person");
  if (verdict?.decision === "accepted") return statePill("accepted", "Closeout accepted");
  if (item?.state === "merge_queue") return statePill("merge_queue", "Waiting to merge");
  if (item?.state === "verifying" || run.state === "verifying")
    return statePill("verifying", "Closeout");
  return statePill(run.state, runLabel(run.state));
}

function itemVerdict(snapshot: StatusSnapshot, itemId: string): StatusVerdict | undefined {
  return snapshot.verdicts.find((entry) => entry.itemId === itemId);
}

function itemLink(item: StatusItem | undefined): string {
  if (!item) return "";
  return `<a class="lin-id" href="${routeHref({ view: "issues", id: item.id })}">${esc(item.id)}</a>`;
}

function findItem(snapshot: StatusSnapshot, id: string): StatusItem | undefined {
  return snapshot.items.find((item) => item.id === id);
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
