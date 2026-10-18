import { SETTINGS_PAGES, renderSettingsPage } from "./settings-pages";
import type {
  StatusCheck,
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
  durationLabel,
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

function renderView(snapshot: StatusSnapshot, model: RenderModel): string {
  if (model.route.view === "sessions")
    return renderConversations(model.conversations, model.route.id);
  switch (model.route.view) {
    case "overview":
      return viewOverview(snapshot);
    case "issues":
      return viewIssues(snapshot, model.route.id);
    case "runs":
      return viewRuns(snapshot, model.route.id, model.selectedCheck, model.engineUrl);
    case "questions":
      return viewQuestions(snapshot, model.route.id);
    case "runners":
      return '<div id="runner-settings"></div>';
    case "projects":
      return '<div id="project-delivery"></div>';
    case "settings":
      return renderSettingsPage(model.route.page);
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
      <div class="row"><span class="lin-id">${esc(item.id)}</span>${statePill(item.state, itemLabel(item.state))}</div>
      <h2>${esc(item.title)}</h2>
      <div class="row wrap">${issueMeta(item)}</div>
      <div class="row">${linkList(item.links)}</div>
    </div>
    <h3>Runs</h3>
    ${runs.length ? `<ul class="issue-items" role="list">${runs.map((run) => `<li><a href="${routeHref({ view: "runs", id: run.id })}">${esc(run.id)}</a> ${statePill(run.state, runLabel(run.state))}</li>`).join("")}</ul>` : `<p class="muted">No runs yet.</p>`}
    <h3>Blocked by</h3>
    ${relatedIssues(item.blockers)}
    <h3>Blocks</h3>
    ${relatedIssues(blocked.map((entry) => entry.id))}`;
}

function issueRow(snapshot: StatusSnapshot, item: StatusItem): string {
  const blockers = unmergedBlockers(snapshot, item);
  return `<li class="issue-row" data-issue-state="${issueBucket(item)}" data-issue-id="${esc(item.id)}"><a class="work-title" href="${routeHref({ view: "issues", id: item.id })}"><span class="lin-id">${esc(item.id)}</span> <b>${esc(item.title)}</b></a><div class="row wrap">${statePill(item.state, itemLabel(item.state))}${issueMeta(item)}${blockers.length ? `<span>Blocked by ${esc(blockers.join(", "))}</span>` : ""}</div></li>`;
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
  const engine = engineUrl === null ? null : parseEngineUrl(engineUrl);
  const transcriptPath = `/api/runs/transcript?run=${encodeURIComponent(selected.id)}`;
  const transcriptHref = engine === null ? transcriptPath : new URL(transcriptPath, engine).href;
  return `${pageHeading("runs")}${picker}
    <div class="split"><div>
      <div class="row">${itemLink(item)}${phasePill(item, selected, verdict)}${agentChip(selected.agent)}</div>
      <h2>${esc(title)}</h2>
      <p class="muted">${esc(selected.summary)}</p>
      ${phaseStrip(item, selected, verdict)}
      <div id="execution-controls" data-item="${esc(selected.itemId)}" hidden></div>
      <h3>Agent transcript</h3>
      ${snapshot.source === "live" ? `<p><a href="${esc(transcriptHref)}" target="_blank" rel="noopener">Open full transcript</a></p>` : ""}
      <div class="log" role="log" aria-label="Agent transcript" data-log="transcript-${esc(selected.id)}">${selected.transcript?.length ? selected.transcript.map((line) => `<div class="ln ${esc(line.kind)}"><span class="ts">${esc(clock(line.at))}</span><span class="ty">${esc(line.kind === "system" ? "agent" : line.kind)}</span><span class="tx whitespace-pre-wrap break-words">${esc(line.text)}</span></div>`).join("") : '<p class="muted">Waiting for agent output.</p>'}</div>
      <h3>Task activity</h3>
      <div class="log" data-log="activity-${esc(selected.id)}">${selected.activity.map((line) => `<div class="ln ${esc(line.kind)}"><span class="ts">${esc(clock(line.at))}</span><span class="ty">${esc(line.kind)}</span><span class="tx">${esc(line.text)}</span></div>`).join("")}</div>
      ${verificationSection(snapshot, selected.itemId, selectedCheck, engineUrl)}
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

function verificationSection(
  snapshot: StatusSnapshot,
  itemId: string,
  selectedCheck: { itemId: string; checkId: string } | null,
  engineUrl: string | null,
): string {
  const selected = snapshot.verdicts.find((verdict) => verdict.itemId === itemId);
  const picker = entityPicker(
    "Candidate",
    snapshot.verdicts.flatMap((verdict) => {
      const href = runHrefForItem(snapshot, verdict.itemId);
      return href
        ? [{ value: href, label: `${verdict.itemId} · ${verdictLabel(verdict.decision)}` }]
        : [];
    }),
    selected ? (runHrefForItem(snapshot, selected.itemId) ?? "") : "",
  );
  if (!selected)
    return `<h3>Verification</h3>${picker}<div class="empty">No verification for this run yet. Results appear after the agent produces a candidate.</div>`;
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
  return `<h3>Verification</h3>${picker}
    <div class="between closeout-head"><div>
      <div class="row">${itemLink(item)}${item ? statePill(item.state, itemLabel(item.state)) : ""}</div>
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

function runHrefForItem(snapshot: StatusSnapshot, itemId: string): string | null {
  const item = findItem(snapshot, itemId);
  if (item?.runId && snapshot.runs.some((run) => run.id === item.runId)) {
    return routeHref({ view: "runs", id: item.runId });
  }
  let match: StatusRun | undefined;
  for (const run of snapshot.runs) {
    if (run.itemId !== itemId) continue;
    if (!match || run.startedAt > match.startedAt) match = run;
  }
  return match ? routeHref({ view: "runs", id: match.id }) : null;
}

function itemVerdict(snapshot: StatusSnapshot, itemId: string): StatusVerdict | undefined {
  return snapshot.verdicts.find((entry) => entry.itemId === itemId);
}

function policyLabel(verdict: StatusVerdict): string {
  if (verdict.policyPath && verdict.policyDigest) {
    return `${verdict.policyPath} ${verdict.policyDigest}`;
  }
  return verdict.policyDigest || verdict.policyPath || "—";
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
