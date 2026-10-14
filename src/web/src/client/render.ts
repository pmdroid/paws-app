import type {
  StatusCheck,
  StatusEpic,
  StatusItem,
  StatusMergeEntry,
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
  durationLabel,
  epicLabel,
  esc,
  itemLabel,
  linkList,
  runLabel,
  statePill,
  taskPhase,
  verdictDetail,
  verdictLabel,
} from "./format";
import { routeHref, type Route } from "./route";
import { parseEngineUrl } from "../endpoint";
import { renderConversations, type ConversationModel } from "./conversations";
import { PAGES } from "./navigation";

export interface RenderModel {
  conversations?: ConversationModel;
  route: Route;
  phase: "loading" | "ready" | "error";
  snapshot: StatusSnapshot | null;
  via: "bundled" | "engine" | null;
  error: string | null;
  engineUrl: string | null;
  selectedCheck: { itemId: string; checkId: string } | null;
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
  const title = `Paws status · ${PAGES[model.route.view].title}`;
  return {
    top: renderTop(model),
    banner: renderBanner(model),
    content:
      model.route.view === "runners"
        ? '<div id="runner-settings"></div>'
        : model.route.view === "settings"
          ? '<div id="agent-settings" class="agent-settings"></div>'
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
  if (model.phase === "error") {
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

const EMPTY_ITEMS = "No items yet. Add the `paws` label to a Linear issue.";

function renderView(snapshot: StatusSnapshot, model: RenderModel): string {
  if (model.route.view === "sessions")
    return renderConversations(model.conversations, model.route.id);
  switch (model.route.view) {
    case "overview":
      return viewOverview(snapshot);
    case "epics":
      return viewEpics(snapshot, model.route.id);
    case "runs":
      return viewRuns(snapshot, model.route.id, model.selectedCheck, model.engineUrl);
    case "questions":
      return viewQuestions(snapshot, model.route.id);
    case "verdicts":
      return viewVerdicts(snapshot, model.route.id, model.selectedCheck, model.engineUrl);
    case "queue":
      return viewQueue(snapshot);
    case "runners":
      return '<div id="runner-settings"></div>';
    case "settings":
      return '<div id="agent-settings" class="agent-settings"></div>';
  }
}

function viewOverview(snapshot: StatusSnapshot): string {
  if (!snapshot.items.length)
    return `${pageHeading("overview")}<div class="empty">${esc(EMPTY_ITEMS)}</div>`;
  const active = snapshot.runs.filter((run) => ACTIVE_RUN.has(run.state)).length;
  const attention = snapshot.items.filter((item) =>
    ["needs_human", "exhausted"].includes(item.state),
  );
  const work = snapshot.items.filter(
    (item) => !["merged", "completed", "stopped"].includes(item.state),
  );
  const visible = (work.length ? work : [...snapshot.items].reverse()).slice(0, 12);
  return `${pageHeading("overview")}
    <section class="overview-section" aria-labelledby="attention-heading"><div class="between"><h2 id="attention-heading">Needs attention</h2><a href="${routeHref({ view: "questions", id: null })}">Open questions</a></div>
      ${snapshot.questions.map((question) => questionRow(snapshot, question)).join("")}
      ${attention.map((item) => `<div class="it"><a href="${routeHref(item.runId ? { view: "runs", id: item.runId } : { view: "epics", id: item.epicId })}"><b>${esc(item.id)}</b> ${esc(item.title)}</a> ${statePill(item.state, itemLabel(item.state))}<div>${linkList(item.links)}</div></div>`).join("")}
      ${!snapshot.questions.length && !attention.length ? '<p class="muted">No work needs your attention.</p>' : ""}
    </section>
    <div class="overview-columns"><section class="overview-section" aria-labelledby="work-heading"><div class="between"><h2 id="work-heading">${work.length ? "Work in progress" : "Recent work"}</h2><a href="${routeHref({ view: "runs", id: null })}">${active} active runs</a></div>
      <div class="overview-epics">${snapshot.epics.map((epic) => `<a href="${routeHref({ view: "epics", id: epic.id })}">${esc(epic.title)}</a>`).join("")}</div>
      <ul class="overview-work" role="list">${visible
        .map((item) => {
          const run = snapshot.runs.find((entry) => entry.id === item.runId);
          const blockers = item.blockers.filter(
            (id) => !["merged", "completed"].includes(findItem(snapshot, id)?.state ?? "queued"),
          );
          return `<li><div class="between"><a class="work-title" href="${routeHref(run ? { view: "runs", id: run.id } : { view: "epics", id: item.epicId })}"><span class="lin-id">${esc(item.id)}</span> <b>${esc(item.title)}</b></a>${run ? phasePill(item, run, itemVerdict(snapshot, item.id)) : statePill(item.state, itemLabel(item.state))}</div><div class="row wrap muted">${agentChip(item.agent)}${blockers.length ? `<span>Waiting on ${esc(blockers.join(", "))}</span>` : ""}${linkList(item.links)}</div></li>`;
        })
        .join("")}</ul>
      <a href="${routeHref({ view: "epics", id: null })}">View epics and dependencies</a>
    </section><section class="overview-section" aria-labelledby="delivery-heading"><div class="between"><h2 id="delivery-heading">Delivery</h2><a href="${routeHref({ view: "queue" })}">Merge queue${snapshot.mergeQueue.length ? ` · ${snapshot.mergeQueue.length}` : ""}</a></div>
      ${
        snapshot.mergeQueue.length
          ? [...snapshot.mergeQueue]
              .sort((a, b) => a.position - b.position)
              .map((entry) => queueRow(snapshot, entry))
              .join("")
          : '<p class="muted">No pull requests are waiting to merge.</p>'
      }
      <h3>Recent events</h3><div class="list overview-events">${events(snapshot)}</div>
    </section></div>`;
}

function viewEpics(snapshot: StatusSnapshot, id: string | null): string {
  const selected = snapshot.epics.find((epic) => epic.id === id);
  if (id && !selected)
    return `${pageHeading("epics")}<div class="empty">Epic not found. Choose an epic from the list.</div>${entityPicker(
      "Epic",
      snapshot.epics.map((epic) => ({
        value: routeHref({ view: "epics", id: epic.id }),
        label: `${epic.id} · ${epic.title}`,
      })),
      "",
    )}`;
  if (selected) return epicDetail(snapshot, selected);
  if (!snapshot.epics.length)
    return `${pageHeading("epics")}<div class="empty">No epics yet. Delegate a parent issue in Linear to see its work here.</div>`;
  return `${pageHeading("epics")}
    <div class="epic-filters" role="group" aria-label="Filter epics">
      <button type="button" class="btn on" data-action="epic-filter" data-epic-filter="all" aria-pressed="true">All</button>
      <button type="button" class="btn" data-action="epic-filter" data-epic-filter="active" aria-pressed="false">Active</button>
      <button type="button" class="btn" data-action="epic-filter" data-epic-filter="needs" aria-pressed="false">Needs attention</button>
      <button type="button" class="btn" data-action="epic-filter" data-epic-filter="done" aria-pressed="false">Done</button>
    </div>
    <ul class="epic-list" role="list">${snapshot.epics.map((epic) => epicRow(snapshot, epic)).join("")}</ul>
    <p class="empty epic-filter-empty" hidden>No epics match this filter.</p>`;
}

function epicDetail(snapshot: StatusSnapshot, selected: StatusEpic): string {
  const items = snapshot.items.filter((item) => item.epicId === selected.id);
  const state = selected.delegated
    ? statePill(selected.state === "done" ? "merged" : selected.state, epicLabel(selected.state))
    : '<span class="tag">Not delegated</span>';
  return `${pageHeading("epics")}
    <a href="${routeHref({ view: "epics", id: null })}">All epics</a>
    <div class="epic-head">
      <div class="row"><span class="lin-id">${esc(selected.id)}</span>${state}</div>
      <h2>${esc(selected.title)}</h2>
      <p class="muted">${esc(selected.description)}</p>
      <div class="row">${linkList(selected.links)}</div>
    </div>
    ${items.length ? `<ul class="epic-items" role="list">${items.map((item) => epicItem(item)).join("")}</ul>` : `<div class="empty">No items yet.</div>`}`;
}

function epicRow(snapshot: StatusSnapshot, epic: StatusEpic): string {
  const items = snapshot.items.filter((item) => item.epicId === epic.id);
  const open = items.filter((item) => !["merged", "completed", "stopped"].includes(item.state));
  const needs = items.some((item) =>
    ["needs_human", "exhausted", "awaiting_input"].includes(item.state),
  );
  const state = epic.delegated
    ? statePill(epic.state === "done" ? "merged" : epic.state, epicLabel(epic.state))
    : '<span class="tag">Not delegated</span>';
  return `<li class="epic-row" data-epic-state="${esc(epicFilter(epic, needs, open.length))}"><a class="work-title" href="${routeHref({ view: "epics", id: epic.id })}"><span class="lin-id">${esc(epic.id)}</span> <b>${esc(epic.title)}</b></a><div class="row wrap">${state}<span class="muted">${open.length} open · ${items.length} items</span></div></li>`;
}

function epicFilter(epic: StatusEpic, needs: boolean, open: number): string {
  if (needs || epic.state === "awaiting_input") return "needs";
  if (epic.delegated && epic.state === "done" && open === 0) return "done";
  return "active";
}

function epicItem(item: StatusItem): string {
  const href = item.runId
    ? routeHref({ view: "runs", id: item.runId })
    : routeHref({ view: "epics", id: item.epicId });
  return `<li><div class="between"><a class="work-title" href="${href}"><span class="lin-id">${esc(item.id)}</span> <b>${esc(item.title)}</b></a>${statePill(item.state, itemLabel(item.state))}</div><div class="row wrap muted">${agentChip(item.agent)}${item.blockers.length ? `<span>Waiting on ${esc(item.blockers.join(", "))}</span>` : ""}</div></li>`;
}

function viewRuns(
  snapshot: StatusSnapshot,
  id: string | null,
  selectedCheck: { itemId: string; checkId: string } | null,
  engineUrl: string | null,
): string {
  const runs = [...snapshot.runs].sort(
    (a, b) => rankRun(a) - rankRun(b) || b.startedAt.localeCompare(a.startedAt),
  );
  const selected = runs.find((run) => run.id === id) ?? (id === null ? runs[0] : undefined);
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
  return `${pageHeading("runs")}${picker}
    <div class="split"><div>
      <div class="row">${itemLink(item)}${phasePill(item, selected, verdict)}${agentChip(selected.agent)}</div>
      <h2>${esc(title)}</h2>
      <p class="muted">${esc(selected.summary)}</p>
      ${phaseStrip(item, selected, verdict)}
      <div id="execution-controls" data-item="${esc(selected.itemId)}" hidden></div>
      <div class="log" data-log="activity-${esc(selected.id)}">${selected.activity.map((line) => `<div class="ln ${esc(line.kind)}"><span class="ts">${esc(clock(line.at))}</span><span class="ty">${esc(line.kind)}</span><span class="tx">${esc(line.text)}</span></div>`).join("")}</div>
      ${runCloseout(snapshot, selected.itemId, selectedCheck, engineUrl)}
    </div>
    <div class="card"><h3>Run</h3><div class="kv">
      <span class="k">Run</span><span class="mono">${esc(selected.id)}</span>
      <span class="k">Item</span><span class="mono">${esc(selected.itemId)}</span>
      <span class="k">Agent</span><span>${agentChip(selected.agent)}</span>
      <span class="k">Reviewer</span><span>${agentChip(selected.reviewer)}</span>
      <span class="k">Started</span><span>${esc(ago(selected.startedAt, snapshot.generatedAt))}</span>
      <span class="k">Attempt</span><span class="mono">${selected.attempt}</span>
      <span class="k">Branch</span><span class="mono">${esc(item?.branch ?? "—")}</span>
      <span class="k">Links</span><span>${linkList(selected.links) || "—"}</span>
    </div></div></div>`;
}

function viewQuestions(snapshot: StatusSnapshot, id: string | null): string {
  const cards = snapshot.questions
    .map((question) => questionCard(snapshot, question, question.id === id))
    .join("");
  return `${pageHeading("questions")}
    ${cards || '<div class="empty">No open questions.</div>'}`;
}

function viewVerdicts(
  snapshot: StatusSnapshot,
  id: string | null,
  selectedCheck: { itemId: string; checkId: string } | null,
  engineUrl: string | null,
): string {
  const verdicts = snapshot.verdicts;
  const selected =
    verdicts.find((verdict) => verdict.itemId === id) ?? (id === null ? verdicts[0] : undefined);
  const picker = entityPicker(
    "Candidate",
    verdicts.map((verdict) => ({
      value: routeHref({ view: "verdicts", id: verdict.itemId }),
      label: `${verdict.itemId} · ${verdictLabel(verdict.decision)}`,
    })),
    selected ? routeHref({ view: "verdicts", id: selected.itemId }) : "",
  );
  if (!selected)
    return `${pageHeading("verdicts")}${picker}<div class="empty">${id ? "Candidate not found. Choose another verification result." : "No Closeout verdicts yet. Verification results appear here after an agent produces a candidate."}</div>`;
  const item = findItem(snapshot, selected.itemId);
  const bars = Array.from({ length: selected.maxAttempts }, (_, index) => {
    const n = index + 1;
    const cls = n < selected.attempt ? "f" : n > selected.attempt ? "" : barClass(selected);
    return `<i class="${cls}"></i>`;
  }).join("");
  const fail =
    selected.failingCheck && selected.decision !== "accepted"
      ? `<div class="mono">${esc(selected.failingCheck)}</div>`
      : "";
  return `${pageHeading("verdicts")}${picker}
    <div class="between closeout-head"><div>
      <div class="row">${itemLink(item)}${item ? statePill(item.state, itemLabel(item.state)) : ""}</div>
      <h2>${esc(item?.title ?? selected.itemId)}</h2>
      ${item ? phaseStrip(item, runForItem(snapshot, item.id), selected) : ""}
      <div class="muted">${esc(selected.summary)}</div>
    </div>
    <div><div class="muted">Attempt ${selected.attempt}/${selected.maxAttempts}</div><div class="attempts">${bars}</div></div></div>
    <div class="decision ${esc(selected.decision)}"><div class="big">${esc(verdictLabel(selected.decision))}</div><div class="muted">${esc(verdictDetail(selected.decision))}${fail}</div></div>
    <div class="card">${checks(selected, selectedCheck, engineUrl)}</div>
    <div class="card"><h3>Report</h3><div class="kv">
      <span class="k">Base</span><span class="mono">${esc(selected.baseSha ?? "—")}</span>
      <span class="k">Head</span><span class="mono">${esc(selected.headSha ?? "—")}</span>
      <span class="k">Policy</span><span class="mono">${esc(policyLabel(selected))}</span>
      <span class="k">Sealed</span><span>${selected.sealed ? "yes" : "no"}</span>
      <span class="k">Links</span><span>${linkList(selected.links) || "—"}</span>
    </div></div>`;
}

function viewQueue(snapshot: StatusSnapshot): string {
  const entries = [...snapshot.mergeQueue].sort((a, b) => a.position - b.position);
  const merged = snapshot.items.filter((item) => item.state === "merged");
  const body = entries.length
    ? entries
        .map((entry, index) => {
          const item = findItem(snapshot, entry.itemId);
          const processing = index === 0;
          const steps = entry.steps
            .map((step) => {
              const cls = processing ? step.state : "wait";
              const mark =
                processing && step.state === "done"
                  ? "✓"
                  : processing && step.state === "run"
                    ? "●"
                    : "○";
              const detail =
                processing && step.detail
                  ? ` <span class="mono dim">${esc(step.detail)}</span>`
                  : "";
              return `<div class="step ${cls}">${mark} ${esc(step.name)}${detail}</div>`;
            })
            .join("");
          return `<div class="qe"><div class="pos">${entry.position}</div><div>
          <div class="between"><div class="row">${itemLink(item)}<b>${esc(item?.title ?? entry.itemId)}</b>${item?.pr ? `<span class="mono muted">PR #${item.pr.number}</span>` : ""}${item ? agentChip(item.agent) : ""}</div>
          <span class="muted">${processing ? "processing" : "waiting"} · queued ${esc(ago(entry.enqueuedAt, snapshot.generatedAt))}</span></div>
          <div class="steps">${steps}</div></div></div>`;
        })
        .join("")
    : '<div class="empty">Queue is empty.</div>';
  const recent = merged.length
    ? `<div class="card"><h2>Recently merged</h2><div class="tw"><table><tr><th>Item</th><th>PR</th><th class="hide-phone">Agent</th><th>Assignee</th></tr>
        ${merged
          .map(
            (item) =>
              `<tr><td>${itemLink(item)} ${esc(item.title)}</td><td class="mono">${item.pr ? `#${item.pr.number}` : "—"}</td><td class="hide-phone">${agentChip(item.agent)}</td><td>${avatar(item.assignee, true)} ${esc(item.assignee)}</td></tr>`,
          )
          .join("")}
      </table></div></div>`
    : "";
  return `${pageHeading("queue")}
    <div class="sub">Serial. Each pull request is rebased onto main and Closeout runs again, because old evidence goes stale on a new base.</div>
    ${body}${recent}`;
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
    ? `${avatar(question.claimedBy, true)} ${esc(question.claimedBy)} claimed`
    : "unclaimed";
  return `<article class="q${highlight ? " hl" : ""}" id="q-${esc(question.id)}">
    <div class="qh"><div>
      <div class="row wrap"><span class="lin-id">${esc(question.id)}</span><span class="tag${question.kind === "exhausted" ? " bad" : ""}">${esc(question.kind)}</span><span class="tag">${esc(question.urgency)}</span>${itemLink(item)}${item ? agentChip(item.agent) : ""}</div>
      <div class="title">${esc(question.title)}</div>
    </div>
    <div class="dim">${claimed}<div>${esc(ago(question.askedAt, snapshot.generatedAt))}</div></div></div>
    <div class="qb"><div class="muted">${esc(question.body)}</div>
      ${question.context ? `<div class="ctx">${esc(question.context)}</div>` : ""}
      ${options}
      <div class="row">${question.links.length ? linkList(question.links) : '<span class="dim">Answer in the source conversation to continue.</span>'}</div>
    </div></article>`;
}

function questionRow(snapshot: StatusSnapshot, question: StatusQuestion): string {
  return `<div class="it"><a href="${routeHref({ view: "questions", id: question.id })}"><b>${esc(question.title)}</b></a><div class="muted">${esc(question.itemId)} · ${esc(ago(question.askedAt, snapshot.generatedAt))}</div>${question.links.length ? `<div>${linkList(question.links)}</div>` : ""}</div>`;
}

function queueRow(snapshot: StatusSnapshot, entry: StatusMergeEntry): string {
  const item = findItem(snapshot, entry.itemId);
  return `<div class="it"><a href="${routeHref({ view: "queue" })}"><b>#${entry.position}</b> ${esc(item?.title ?? entry.itemId)}</a><div class="dim">${esc(entry.itemId)} · ${esc(ago(entry.enqueuedAt, snapshot.generatedAt))}</div></div>`;
}

function events(snapshot: StatusSnapshot): string {
  const rows = [...snapshot.events].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8);
  if (!rows.length) return '<div class="dim">No events.</div>';
  return rows
    .map((event) => {
      return `<div class="it row"><span class="mono dim">${esc(clock(event.at))}</span><span>${esc(event.text)}</span></div>`;
    })
    .join("");
}

function checks(
  verdict: StatusVerdict,
  selectedCheck: { itemId: string; checkId: string } | null,
  engineUrl: string | null,
): string {
  const picked = chosenCheck(verdict, selectedCheck);
  const rows = verdict.checks
    .map((check) => {
      const on = check.id === picked?.id ? " on" : "";
      const current = check.id === picked?.id ? ` aria-current="true"` : "";
      const detail = check.detail ? `<div class="dim">${esc(check.detail)}</div>` : "";
      const meta = checkMeta(check);
      return `<button class="chk${on}" type="button" data-action="select-check" data-item="${esc(verdict.itemId)}" data-check="${esc(check.id)}"${current}><span class="ico ${esc(check.state)}">${checkMark(check.state)}</span><span class="mono">${esc(check.id)}</span><span><span class="mono muted">${esc(check.command)}</span>${detail}${meta ? `<div class="dim">${meta}</div>` : ""}</span><span class="tag">${esc(check.kind)}</span></button>`;
    })
    .join("");
  return `${rows}${picked ? checkDetail(verdict, picked, engineUrl) : ""}`;
}

function chosenCheck(
  verdict: StatusVerdict,
  selectedCheck: { itemId: string; checkId: string } | null,
): StatusCheck | undefined {
  if (selectedCheck?.itemId === verdict.itemId) {
    const chosen = verdict.checks.find((check) => check.id === selectedCheck.checkId);
    if (chosen) return chosen;
  }
  return (
    verdict.checks.find((check) => check.active) ??
    verdict.checks.find((check) => check.state === "failed" || check.state === "blocked") ??
    verdict.checks[0]
  );
}

function checkDetail(verdict: StatusVerdict, check: StatusCheck, engineUrl: string | null): string {
  const meta = checkMeta(check);
  const findings = check.findings
    ? `<h3>Findings</h3><pre class="out" tabindex="0" data-log="${logKey(verdict.itemId, check.id, "findings")}">${esc(check.findings)}</pre>`
    : "";
  const paths =
    check.state === "running" || check.state === "pending"
      ? ""
      : [
          check.logPath
            ? artifactLink(verdict, check, "log", "Log", "closeout.log", engineUrl)
            : "",
          check.evidencePath
            ? artifactLink(verdict, check, "evidence", "Evidence", "evidence.json", engineUrl)
            : "",
        ].join("");
  const download =
    check.stdout || check.stderr
      ? `<button class="btn sm ghost" type="button" data-action="download-output" data-item="${esc(verdict.itemId)}" data-check="${esc(check.id)}">Download log</button>`
      : "";
  return `<div class="check-detail"><div class="between"><h3>${esc(check.id)}</h3>${download}</div>${meta ? `<div class="dim">${meta}</div>` : ""}${commandOutput(verdict.itemId, check)}${findings}${paths ? `<div class="artifact">${paths}</div>` : ""}</div>`;
}

function artifactLink(
  verdict: StatusVerdict,
  check: StatusCheck,
  kind: "log" | "evidence",
  label: string,
  filename: string,
  engineUrl: string | null,
): string {
  const params = new URLSearchParams({
    item: verdict.itemId,
    check: check.id,
    kind,
    head: verdict.headSha ?? "",
    policy: verdict.policyDigest ?? "",
  });
  const path = `/api/closeout-artifact?${params.toString()}`;
  const engine = parseEngineUrl(engineUrl ?? "");
  const href = engine === null ? path : new URL(path, engine).href;
  return `<a href="${esc(href)}" download="${filename}">${label}</a>`;
}

function commandOutput(itemId: string, check: StatusCheck): string {
  const stdout = check.stdout ?? "";
  const stderr = check.stderr ?? "";
  if (!stdout && !stderr) {
    return check.state === "running" ? `<p class="muted">Waiting for output.</p>` : "";
  }
  const blocks = [
    stdout
      ? `<div class="stream"><span>stdout</span><pre class="out" tabindex="0" data-log="${logKey(itemId, check.id, "stdout")}">${esc(stdout)}</pre></div>`
      : "",
    stderr
      ? `<div class="stream"><span>stderr</span><pre class="out" tabindex="0" data-log="${logKey(itemId, check.id, "stderr")}">${esc(stderr)}</pre></div>`
      : "",
  ].join("");
  const note = check.truncated ? `<p class="muted">Output truncated.</p>` : "";
  return `${blocks}${note}`;
}

function logKey(itemId: string, checkId: string, stream: string): string {
  return `${encodeURIComponent(itemId)}:${encodeURIComponent(checkId)}:${stream}`;
}

function checkMeta(check: StatusCheck): string {
  const parts: string[] = [];
  if (check.attempt) parts.push(`attempt ${check.attempt}`);
  if (typeof check.elapsedMs === "number") {
    parts.push(`${durationLabel(check.elapsedMs)} elapsed`);
  }
  if (typeof check.timeoutSeconds === "number") {
    parts.push(`timeout ${durationLabel(check.timeoutSeconds * 1000)}`);
  }
  if (typeof check.exitCode === "number") parts.push(`exit ${check.exitCode}`);
  if (check.timedOut) parts.push(check.timeoutReason || "timed out");
  return parts.join(" · ");
}

function checkMark(state: string): string {
  if (state === "passed") return "✓";
  if (state === "failed" || state === "blocked" || state === "exhausted") return "✕";
  if (state === "skipped") return "–";
  return "";
}

function phaseStrip(
  item: StatusItem | undefined,
  run: StatusRun | undefined,
  verdict?: StatusVerdict,
): string {
  const phase = taskPhase(item?.state ?? null, run?.state ?? "running", verdict?.decision);
  const names = ["Implementation", "Closeout", "Waiting to merge", "Complete"];
  const marks = names
    .map((name, index) => {
      const cls = index < phase.current ? "done" : index === phase.current ? "now" : "wait";
      return `<span class="ph ${cls}">${esc(name)}</span>`;
    })
    .join("");
  return `<div class="phase"><div class="phs">${marks}</div><p>${esc(phase.detail)}</p></div>`;
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
    return statePill("exhausted", "Exhausted");
  if (verdict?.decision === "rejected") return statePill("stopped", "Closeout failed");
  if (item?.state === "needs_human") return statePill("needs_human", "Needs a person");
  if (item?.state === "merge_queue") return statePill("merge_queue", "Waiting to merge");
  if (item?.state === "verifying" || run.state === "verifying")
    return statePill("verifying", "Closeout");
  return statePill(run.state, runLabel(run.state));
}

function runCloseout(
  snapshot: StatusSnapshot,
  itemId: string,
  selectedCheck: { itemId: string; checkId: string } | null,
  engineUrl: string | null,
): string {
  const verdict = snapshot.verdicts.find((entry) => entry.itemId === itemId);
  if (!verdict || verdict.checks.length === 0) return "";
  const check = chosenCheck(verdict, selectedCheck);
  if (!check) return "";
  return `<div class="card"><div class="between"><h3>Closeout</h3><a href="${routeHref({ view: "verdicts", id: itemId })}">All checks</a></div>${checkDetail(verdict, check, engineUrl)}</div>`;
}

function itemVerdict(snapshot: StatusSnapshot, itemId: string): StatusVerdict | undefined {
  return snapshot.verdicts.find((entry) => entry.itemId === itemId);
}

function runForItem(snapshot: StatusSnapshot, itemId: string): StatusRun | undefined {
  return snapshot.runs.find((run) => run.itemId === itemId);
}

function policyLabel(verdict: StatusVerdict): string {
  if (verdict.policyPath && verdict.policyDigest) {
    return `${verdict.policyPath} ${verdict.policyDigest}`;
  }
  return verdict.policyDigest || verdict.policyPath || "—";
}

function itemLink(item: StatusItem | undefined): string {
  if (!item) return "";
  return `<a class="lin-id" href="${routeHref({ view: "epics", id: item.epicId })}">${esc(item.id)}</a>`;
}

function findItem(snapshot: StatusSnapshot, id: string): StatusItem | undefined {
  return snapshot.items.find((item) => item.id === id);
}

function rankRun(run: StatusRun): number {
  return ACTIVE_RUN.has(run.state) ? 0 : 1;
}

function barClass(verdict: StatusVerdict): string {
  if (verdict.decision === "accepted") return "p";
  if (verdict.decision === "running") return "r";
  return "f";
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
