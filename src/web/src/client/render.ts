import { SETTINGS_PAGES, renderSettingsPage } from "./settings-pages";
import type {
  StatusItem,
  StatusQuestion,
  StatusRun,
  StatusSnapshot,
  StatusVerdict,
} from "../contract";
import {
  agentChip,
  ago,
  avatar,
  clock,
  esc,
  itemLabel,
  linkList,
  runLabel,
  statePill,
  taskPhase,
} from "./format";
import { needsSnapshot, routeHref, type Route } from "./route";
import { parseEngineUrl } from "../endpoint";
import { emptyCloseoutView, renderCloseoutChecks, type CloseoutView } from "./closeout";
import { renderConversations, type ConversationModel } from "./conversations";
import { evidenceSlot, renderEvidencePage, type MediaInfo } from "./evidence";
import { PAGES } from "./navigation";

export interface RenderModel {
  conversations?: ConversationModel;
  route: Route;
  phase: "loading" | "ready" | "error";
  snapshot: StatusSnapshot | null;
  via: "bundled" | "engine" | null;
  error: string | null;
  engineUrl: string | null;
  closeout?: CloseoutView;
  /** Task activity sections the reader opened or closed, by `activityKey`. */
  activity?: Record<string, boolean>;
  mediaInfo?: ReadonlyMap<string, MediaInfo>;
}

export interface Rendered {
  top: string;
  banner: string;
  content: string;
  title: string;
}

const ACTIVE_RUN = new Set(["running", "awaiting_input", "verifying", "paused"]);

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
        : model.route.view === "projects"
          ? '<div id="project-delivery"></div>'
          : model.route.view === "settings"
            ? renderSettingsPage(model.route.page)
            : model.route.view === "sessions"
              ? renderConversations(model.conversations, model.route.id)
              : snapshot && model.phase !== "loading"
                ? renderView(snapshot, model)
                : renderPending(model),
    title,
  };
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
      return viewIssues(snapshot, model.route.id);
    case "runs":
      return viewRuns(
        snapshot,
        model.route.id,
        model.closeout ?? emptyCloseoutView(),
        model.engineUrl,
        model.activity ?? {},
      );
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
    case "projects":
      return '<div id="project-delivery"></div>';
    case "settings":
      return renderSettingsPage(model.route.page);
    case "sessions":
      return renderConversations(model.conversations, model.route.id);
  }
}

function viewOverview(snapshot: StatusSnapshot): string {
  if (!snapshot.items.length && !snapshot.questions.length)
    return `${pageHeading("overview")}<div class="empty">${esc(EMPTY_ISSUES)}</div>`;
  const runs = new Map(snapshot.runs.map((run) => [run.id, run]));
  const attention = snapshot.items.flatMap((item) => {
    const run = item.runId ? runs.get(item.runId) : undefined;
    const question = snapshot.questions.find((entry) => entry.itemId === item.id);
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
      item.state === "signoff"
        ? "Your sign-off is needed before this can continue."
        : item.state === "exhausted" || verdict?.decision === "exhausted"
          ? "Automatic retries are used up."
          : item.state === "needs_human" || verdict?.decision === "blocked"
            ? "Work is blocked and needs a person."
            : item.state === "awaiting_input" || run?.state === "awaiting_input"
              ? "Waiting for your input."
              : run?.state === "paused"
                ? "This run is paused."
                : null;
    return reason
      ? [
          {
            itemId: item.id,
            title: item.title,
            reason,
            action: item.state === "signoff" ? "Review sign-off" : "Review issue",
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
      !unmergedBlockers(snapshot, item).length
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
      ${attention.length ? `<ul class="overview-work" role="list">${attention.map((entry) => `<li class="overview-row"><div class="overview-copy"><div><span class="lin-id">${esc(entry.itemId)}</span> <b>${esc(entry.title)}</b></div><p class="muted">${esc(entry.reason)}</p></div><a href="${entry.href}" aria-label="${esc(`${entry.action}: ${entry.itemId}`)}">${esc(entry.action)}</a></li>`).join("")}</ul>` : '<p class="muted">Nothing needs your attention.</p>'}
    </section>
    <section class="overview-section" aria-labelledby="work-heading"><h2 id="work-heading">Working now</h2>
      ${
        work.length
          ? `<ul class="overview-work" role="list">${work
              .slice(0, 6)
              .map((item) => {
                const run = item.runId ? runs.get(item.runId) : undefined;
                const href = routeHref(
                  run ? { view: "runs", id: run.id } : { view: "issues", id: item.id },
                );
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

function viewIssues(snapshot: StatusSnapshot, id: string | null): string {
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
  if (selected) return issueDetail(snapshot, selected);
  if (!snapshot.items.length)
    return `${pageHeading("issues")}<div class="empty">${esc(EMPTY_ISSUES)}</div>`;
  return `${pageHeading("issues")}
    <div class="issue-filters" role="group" aria-label="Filter issues">
      <button type="button" class="btn on" data-action="issue-filter" data-issue-filter="all" aria-pressed="true">All</button>
      <button type="button" class="btn" data-action="issue-filter" data-issue-filter="active" aria-pressed="false">Active</button>
      <button type="button" class="btn" data-action="issue-filter" data-issue-filter="needs" aria-pressed="false">Needs attention</button>
      <button type="button" class="btn" data-action="issue-filter" data-issue-filter="done" aria-pressed="false">Done</button>
    </div>
    <ul class="issue-list" role="list">${snapshot.items.map((item) => issueRow(snapshot, item)).join("")}</ul>
    <p class="empty issue-filter-empty" hidden>No issues match this filter.</p>`;
}

function issueDetail(snapshot: StatusSnapshot, item: StatusItem): string {
  const runs = itemRuns(snapshot, item.id);
  const blocked = snapshot.items.filter(
    (entry) => entry.id !== item.id && entry.blockers.includes(item.id),
  );
  return `${pageHeading("issues")}
    <a href="${routeHref({ view: "issues", id: null })}">All issues</a>
    <div class="issue-head">
      <span class="lin-id">${esc(item.id)}</span>
      <div class="issue-title"><h2>${esc(item.title)}</h2>${statePill(item.state, itemLabel(item.state))}</div>
      <div class="issue-facts">${issueMeta(item)}</div>
      <div class="row">${linkList(item.links)}</div>
    </div>
    <h3>Runs</h3>
    ${runs.length ? `<ul class="issue-items" role="list">${runs.map((run) => `<li><div class="between"><a href="${routeHref({ view: "runs", id: run.id })}">${esc(run.id)}</a>${statePill(run.state, runLabel(run.state))}</div></li>`).join("")}</ul>` : `<p class="muted">No runs yet.</p>`}
    <h3>Blocked by</h3>
    ${relatedIssues(item.blockers)}
    <h3>Blocks</h3>
    ${relatedIssues(blocked.map((entry) => entry.id))}`;
}

function issueRow(snapshot: StatusSnapshot, item: StatusItem): string {
  const blockers = unmergedBlockers(snapshot, item);
  return `<li class="issue-row" data-issue-state="${issueBucket(item)}" data-issue-id="${esc(item.id)}"><a class="work-title" href="${routeHref({ view: "issues", id: item.id })}"><span class="lin-id">${esc(item.id)}</span> <b>${esc(item.title)}</b></a>${statePill(item.state, itemLabel(item.state))}<div class="issue-facts">${issueMeta(item)}${blockers.length ? `<span class="muted">Blocked by ${esc(blockers.join(", "))}</span>` : ""}</div></li>`;
}

function issueMeta(item: StatusItem): string {
  const facts = [item.owner, item.project?.name ?? "Solo"].filter(Boolean);
  return `<span class="muted">${esc(facts.join(" · "))}</span>`;
}

function issueBucket(item: StatusItem): "needs" | "done" | "active" {
  if (["needs_human", "exhausted", "awaiting_input", "signoff"].includes(item.state))
    return "needs";
  if (item.state === "merged" || item.state === "completed") return "done";
  return "active";
}

function relatedIssues(ids: readonly string[]): string {
  if (!ids.length) return `<p class="muted">None.</p>`;
  return `<div class="row wrap">${ids.map((id) => `<a href="${routeHref({ view: "issues", id })}">${esc(id)}</a>`).join("")}</div>`;
}

function itemRuns(snapshot: StatusSnapshot, itemId: string): StatusRun[] {
  return snapshot.runs
    .filter((run) => run.itemId === itemId)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

function unmergedBlockers(snapshot: StatusSnapshot, item: StatusItem): string[] {
  return item.blockers.filter(
    (id) => !["merged", "completed"].includes(findItem(snapshot, id)?.state ?? "queued"),
  );
}

function viewRuns(
  snapshot: StatusSnapshot,
  id: string | null,
  closeout: CloseoutView,
  engineUrl: string | null,
  activity: Record<string, boolean>,
): string {
  const runs = [...snapshot.runs].sort(
    (a, b) => rankRun(a) - rankRun(b) || b.startedAt.localeCompare(a.startedAt),
  );
  if (id === null && runs.length)
    return `${pageHeading("runs")}<ul class="issue-list">${runs.map((run) => `<li class="between"><a href="${routeHref({ view: "runs", id: run.id })}"><span class="mono">${esc(run.id)}</span> · ${esc(findItem(snapshot, run.itemId)?.title ?? run.itemId)}</a>${statePill(run.state, runLabel(run.state))}</li>`).join("")}</ul>`;
  const selected = runs.find((run) => run.id === id);
  const picker = entityPicker(
    "Run",
    runs.map((run) => ({
      value: routeHref({ view: "runs", id: run.id }),
      label: `${run.id} · ${run.itemId} · ${runLabel(run.state)}`,
    })),
    selected ? routeHref({ view: "runs", id: selected.id }) : "",
  );
  if (!selected)
    return `${pageHeading("runs")}${picker}<div class="empty">${id ? "Run not found. Choose another run." : "No runs yet. Agent activity appears here when delegated work starts."}</div>`;
  const item = findItem(snapshot, selected.itemId);
  const title = item?.title ?? selected.itemId;
  const verdict = itemVerdict(snapshot, selected.itemId);
  const engine = engineUrl === null ? null : parseEngineUrl(engineUrl);
  const transcriptPath = `/status/runs/${encodeURIComponent(selected.id)}/transcript`;
  const transcriptHref = engine === null ? transcriptPath : new URL(transcriptPath, engine).href;
  const open = activityOpen(activity, selected);
  return `<article class="run-page">
    <nav class="crumbs" aria-label="Breadcrumb"><a href="${routeHref({ view: "runs", id: null })}">Runs</a><span>/</span>${itemLink(item)}<span>/</span><span class="mono">${esc(selected.id)}</span></nav>
    <header class="run-heading"><div class="row">${itemLink(item)}${phasePill(item, selected, verdict)}<span class="mono muted">${esc(snapshot.project.repo)}${item?.branch ? ` · ${esc(item.branch)}` : ""}</span></div>
      <h1>${esc(title)}</h1>
      <p class="muted">Run ${esc(selected.id)} · ${esc(selected.agent)}${selected.runner ? ` on runner ${esc(selected.runner)}` : ""} · started ${esc(ago(selected.startedAt, snapshot.generatedAt))}</p>
    </header>
    ${phaseStrip(item, selected, verdict)}
    <div id="execution-controls" data-item="${esc(selected.itemId)}" hidden></div>
    ${snapshot.questions
      .filter((question) => question.itemId === selected.itemId)
      .map(
        (question) =>
          `<section class="closeout-result blocked"><div><h2>${esc(question.title)}</h2><p>${esc(question.body)}</p><div class="row">${linkList(question.links)}</div></div></section>`,
      )
      .join("")}
    ${closeoutSection(snapshot, selected.itemId, closeout, engineUrl)}
    ${evidenceSlot(snapshot, selected.id)}
    <details class="run-activity" data-activity="${esc(activityKey(selected))}" data-open="${open}"${open ? ' open=""' : ""}><summary>Task activity${snapshot.source === "live" ? " and agent transcript" : ""}</summary>
      <p class="muted">${esc(selected.summary)}</p>
      ${snapshot.source === "live" ? `<a href="${esc(transcriptHref)}" target="_blank" rel="noopener">Open full agent transcript</a>` : ""}
      <div class="log" data-log="activity-${esc(selected.id)}" data-follow="">${selected.activity.map((line) => `<div class="ln ${esc(line.kind)}"><span class="ts">${esc(clock(line.at))}</span><span class="ty">${esc(line.kind)}</span><span class="tx">${esc(line.text)}</span></div>`).join("")}</div>
      <div class="row">${linkList(selected.links)}</div>
    </details></article>`;
}

/**
 * The reader's choice is kept per phase, so the section the agent's work held
 * open folds back up once the run reaches Closeout.
 */
export function activityKey(run: StatusRun): string {
  return `${run.id}\n${run.state === "running" ? "implementing" : "after"}`;
}

/** The section starts open while the agent implements and closed afterwards. */
function activityOpen(activity: Record<string, boolean>, run: StatusRun): boolean {
  return activity[activityKey(run)] ?? run.state === "running";
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
): string {
  const phase = taskPhase(item?.state ?? null, run?.state ?? "running", verdict?.decision);
  const names = [
    "Implementation",
    `Closeout${verdict ? ` · ${verdict.attempt} of ${verdict.maxAttempts}` : ""}`,
    "Waiting to merge",
    "Complete",
  ];
  const marks = names
    .map((name, index) => {
      const failed =
        index === 1 && verdict && ["exhausted", "rejected", "blocked"].includes(verdict.decision);
      const cls = failed
        ? "failed"
        : index < phase.current || (index === 1 && verdict?.decision === "accepted")
          ? "done"
          : index === phase.current
            ? "now"
            : "wait";
      return `<li class="run-step ${cls}"${index === phase.current ? ' aria-current="step"' : ""}>${cls === "done" ? "✓ " : failed ? "✕ " : ""}${esc(name)}</li>`;
    })
    .join("");
  return `<ol class="run-stepper" aria-label="Run progress" title="${esc(phase.detail)}">${marks}</ol>`;
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
  if (recheck) return statePill("verifying", "Closeout");
  if (verdict?.decision === "blocked") return statePill("needs_human", "Closeout blocked");
  if (verdict?.decision === "exhausted" || item?.state === "exhausted")
    return statePill("exhausted", "Closeout exhausted");
  if (verdict?.decision === "rejected") return statePill("stopped", "Closeout failed");
  if (item?.state === "needs_human") return statePill("needs_human", "Needs a person");
  if (verdict?.decision === "accepted") return statePill("accepted", "Closeout accepted");
  if (item?.state === "merge_queue") return statePill("merge_queue", "Waiting to merge");
  if (item?.state === "verifying" || run.state === "verifying")
    return statePill("verifying", "Closeout");
  return statePill(run.state, runLabel(run.state));
}

function closeoutSection(
  snapshot: StatusSnapshot,
  itemId: string,
  closeout: CloseoutView,
  engineUrl: string | null,
): string {
  const selected = snapshot.verdicts.find((verdict) => verdict.itemId === itemId);
  if (!selected) return "";
  return `<section class="closeout-section" aria-label="Closeout">${renderCloseoutChecks(selected, closeout, engineUrl, findItem(snapshot, itemId)?.pr ?? null, findItem(snapshot, itemId)?.state)}</section>`;
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

function rankRun(run: StatusRun): number {
  return ACTIVE_RUN.has(run.state) ? 0 : 1;
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
