import type {
  ItemState,
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
  epicLabel,
  esc,
  itemLabel,
  linkList,
  runLabel,
  statePill,
  verdictDetail,
  verdictLabel,
} from "./format";
import { routeHref, type Route } from "./route";

export interface RenderModel {
  route: Route;
  phase: "loading" | "ready" | "error";
  snapshot: StatusSnapshot | null;
  via: "bundled" | "engine" | null;
  error: string | null;
  engineUrl: string | null;
  epicView: "graph" | "board";
}

export interface Rendered {
  side: string;
  top: string;
  banner: string;
  content: string;
  tabbar: string;
  title: string;
}

const ITEM_ORDER: ItemState[] = [
  "planning",
  "queued",
  "running",
  "awaiting_input",
  "verifying",
  "signoff",
  "merge_queue",
  "merged",
  "exhausted",
  "stopped",
  "needs_human",
];

const ACTIVE_RUN = new Set(["running", "awaiting_input", "verifying", "paused"]);

const ICONS = {
  overview:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>',
  epic: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="4" cy="4" r="2"/><circle cx="12" cy="4" r="2"/><circle cx="8" cy="12" r="2"/><path d="M5.5 5.5 7 10.5M10.5 5.5 9 10.5"/></svg>',
  run: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 3h12v10H2z"/><path d="m4.5 6.5 2 1.5-2 1.5M8 10h3"/></svg>',
  inbox:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 9h3.5l1 2h3l1-2H14M2 9l2-6h8l2 6v4H2z"/></svg>',
  verify:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 1.5 13.5 4v4c0 3.2-2.5 5.6-5.5 6.5C5 13.6 2.5 11.2 2.5 8V4z"/><path d="m5.5 8 2 2 3-3.5"/></svg>',
  queue:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="4" cy="3.5" r="1.5"/><circle cx="4" cy="12.5" r="1.5"/><circle cx="12" cy="8" r="1.5"/><path d="M4 5v6M4 8h6.5"/></svg>',
};

const NAV = [
  { view: "overview", label: "Overview", icon: "overview" },
  { view: "epics", label: "Epics", icon: "epic" },
  { view: "runs", label: "Agent runs", icon: "run" },
  { view: "questions", label: "Open questions", icon: "inbox" },
  { view: "verdicts", label: "Closeout", icon: "verify" },
  { view: "queue", label: "Merge queue", icon: "queue" },
] as const;

const CRUMB: Record<Route["view"], string> = {
  overview: "Overview",
  epics: "Epics",
  runs: "Agent runs",
  questions: "Open questions",
  verdicts: "Closeout",
  queue: "Merge queue",
};

export function render(model: RenderModel): Rendered {
  const snapshot = model.snapshot;
  const title = `Paws status · ${CRUMB[model.route.view]}`;
  return {
    side: renderSide(model),
    top: renderTop(model),
    banner: renderBanner(model),
    content:
      snapshot && model.phase !== "loading" ? renderView(snapshot, model) : renderPending(model),
    tabbar: renderTabbar(model),
    title,
  };
}

function renderSide(model: RenderModel): string {
  const snapshot = model.snapshot;
  const project = snapshot?.project;
  const workspace = project?.workspace ? `${esc(project.workspace)} · ` : "";
  const counts = snapshot ? navCounts(snapshot) : null;
  const links = NAV.map((item) => {
    const on = model.route.view === item.view ? " on" : "";
    const count = counts ? counts[item.view] : 0;
    const hot = item.view === "questions" && count > 0 ? " hot" : "";
    const badge = count > 0 ? `<span class="cnt${hot}">${count}</span>` : "";
    return `<a class="nav${on}" href="${routeHref({ view: item.view } as Route)}">${ICONS[item.icon]}${item.label}${badge}</a>`;
  }).join("");
  return `<div class="brand"><div class="logo">P</div><div><b>Paws</b><small>status</small></div></div>
    <div class="ws"><div class="row">${workspace}<b>${esc(project?.team ?? "…")}</b></div>
    <div class="row">${esc(project?.repo ?? "Not connected")}</div></div>
    <div class="nav-label">Status</div>
    ${links}
    <div class="foot">Read-only. Questions are answered in Linear.</div>`;
}

function renderTop(model: RenderModel): string {
  const name = model.snapshot?.project.name ?? "Paws";
  const crumb = CRUMB[model.route.view];
  const param = routeParam(model.route);
  const pill = sourcePill(model);
  const clockText = model.snapshot ? clock(model.snapshot.generatedAt) : "";
  return `<button class="btn ghost hamb" type="button" data-action="drawer" aria-label="Open menu">☰</button>
    <div class="crumbs"><span class="c-root">${esc(name)} <span class="dim">/</span></span> <b>${crumb}</b>${param ? ` <span class="c-param"><span class="dim">/</span> <span class="mono">${esc(param)}</span></span>` : ""}</div>
    ${pill}
    <div class="sp"></div>
    <span class="clock">${clockText}</span>
    <button class="btn ghost sm" type="button" data-action="refresh">Refresh</button>
    <button class="btn sm" type="button" data-action="source">Engine</button>`;
}

function renderBanner(model: RenderModel): string {
  if (model.phase === "loading") {
    return `<div class="demo-bar" role="status"><span class="n">Loading</span><span>Fetching status…</span></div>`;
  }
  if (model.phase === "error") {
    const where = model.engineUrl ? ` from ${model.engineUrl}` : "";
    return `<div class="err-bar" role="status"><span class="n">Offline</span><span>${esc(model.error ?? "Could not load status")}${esc(where)}.${model.snapshot ? " Showing the last snapshot." : ""}</span><button class="btn sm" type="button" data-action="source">Change source</button></div>`;
  }
  const snapshot = model.snapshot;
  if (!snapshot) return "";
  if (snapshot.source === "live") {
    return `<div class="live-bar" role="status"><span class="n">Live</span><span>Status from ${esc(model.engineUrl ?? "the engine")} · as of ${esc(clock(snapshot.generatedAt))}.</span></div>`;
  }
  if (model.via === "engine") {
    return `<div class="demo-bar" role="status"><span class="n">Demo</span><span>The engine answered, and this snapshot is still the sample stub. It is not live work.</span></div>`;
  }
  return `<div class="demo-bar" role="status"><span class="n">Demo</span><span>Sample snapshot of a fictional workspace (${esc(snapshot.project.workspace ?? snapshot.project.team)} / ${esc(snapshot.project.repo)}). Not a live engine.</span><button class="btn sm" type="button" data-action="source">Connect engine</button></div>`;
}

function renderPending(model: RenderModel): string {
  if (model.phase === "error") {
    return `<div class="empty"><div style="font-size:15px;color:var(--text);margin-bottom:6px">Status unavailable</div>${esc(model.error ?? "The engine did not return a snapshot.")}<div style="margin-top:14px"><button class="btn primary" type="button" data-action="source">Choose a source</button></div></div>`;
  }
  return `<div class="empty">Loading status…</div>`;
}

function renderTabbar(model: RenderModel): string {
  const counts = model.snapshot ? navCounts(model.snapshot) : null;
  const tabs = [
    ["overview", "Home", "overview"],
    ["epics", "Epics", "epic"],
    ["runs", "Runs", "run"],
    ["questions", "Questions", "inbox"],
    ["verdicts", "Closeout", "verify"],
  ] as const;
  return tabs
    .map(([view, label, icon]) => {
      const on = model.route.view === view ? " on" : "";
      const count = counts ? counts[view] : 0;
      const badge = view === "questions" && count > 0 ? `<span class="cnt">${count}</span>` : "";
      return `<a class="${on}" href="${routeHref({ view } as Route)}" aria-label="${label}">${ICONS[icon]}<span>${label}</span>${badge}</a>`;
    })
    .join("");
}

function renderView(snapshot: StatusSnapshot, model: RenderModel): string {
  switch (model.route.view) {
    case "overview":
      return viewOverview(snapshot);
    case "epics":
      return viewEpics(snapshot, model.route.id, model.epicView);
    case "runs":
      return viewRuns(snapshot, model.route.id);
    case "questions":
      return viewQuestions(snapshot, model.route.id);
    case "verdicts":
      return viewVerdicts(snapshot, model.route.id);
    case "queue":
      return viewQueue(snapshot);
  }
}

function viewOverview(snapshot: StatusSnapshot): string {
  const active = snapshot.runs.filter((run) => ACTIVE_RUN.has(run.state)).length;
  const waiting = snapshot.runs.filter((run) => run.state === "awaiting_input").length;
  const verifying = snapshot.runs.filter((run) => run.state === "verifying").length;
  const open = snapshot.questions.length;
  const queued = snapshot.mergeQueue.length;
  const head = [...snapshot.mergeQueue].sort((a, b) => a.position - b.position)[0];
  const headItem = head ? findItem(snapshot, head.itemId) : undefined;
  const inFlight = snapshot.items.filter((item) => item.state !== "merged").length;
  return `<h1>${esc(snapshot.project.name)}</h1>
    <div class="sub">Epics, items, runs, open questions, Closeout verdicts, and the merge queue.</div>
    <div class="grid g4">
      ${stat("Active runs", String(active), `${waiting} awaiting input · ${verifying} verifying`, active ? Math.min(100, active * 30) : 0, "")}
      ${stat("Open questions", String(open), open ? "Answer them in Linear" : "Nothing is waiting", Math.min(100, open * 25), open ? "var(--amber)" : "")}
      ${stat("Merge queue", String(queued), headItem ? `head: ${headItem.id}` : "empty", Math.min(100, queued * 30), "var(--violet)")}
      ${stat("Items in flight", String(inFlight), `${snapshot.items.length} tracked`, snapshot.items.length ? (inFlight / snapshot.items.length) * 100 : 0, "")}
    </div>
    <div class="row state-strip">${stateStrip(snapshot.items)}</div>
    <div class="card" style="margin-top:14px"><div class="between"><h2>Epics</h2><a href="${routeHref({ view: "epics", id: null })}">All epics</a></div>
      ${epicTable(snapshot)}
    </div>
    <div class="grid g2" style="margin-top:14px">
      <div class="card"><div class="between"><h2>Open questions</h2><a href="${routeHref({ view: "questions", id: null })}">Inbox</a></div>
        ${snapshot.questions.length ? snapshot.questions.map((question) => questionRow(snapshot, question)).join("") : '<div class="empty">No open questions.</div>'}
      </div>
      <div class="card"><div class="between"><h2>Merge queue</h2><a href="${routeHref({ view: "queue" })}">Queue</a></div>
        ${snapshot.mergeQueue.length ? snapshot.mergeQueue.map((entry) => queueRow(snapshot, entry)).join("") : '<div class="empty">Queue is empty.</div>'}
        <h3 style="margin-top:16px">Recent events</h3>
        <div class="list">${events(snapshot)}</div>
      </div>
    </div>`;
}

function viewEpics(snapshot: StatusSnapshot, id: string | null, mode: "graph" | "board"): string {
  const selected = snapshot.epics.find((epic) => epic.id === id) ?? snapshot.epics[0];
  if (!selected) return `<div class="empty">No epics.</div>`;
  const tabs = snapshot.epics
    .map((epic) => {
      const on = epic.id === selected.id ? " on" : "";
      return `<a class="tab${on}" href="${routeHref({ view: "epics", id: epic.id })}">${esc(epic.id)} · ${esc(epic.title)}</a>`;
    })
    .join("");
  const items = snapshot.items.filter((item) => item.epicId === selected.id);
  const graphOn = mode === "graph" ? " on" : "";
  const boardOn = mode === "board" ? " on" : "";
  const toggle = items.length
    ? `<div class="tabs" style="margin:0;border:0"><button class="tab${graphOn}" type="button" data-action="epic-view" data-mode="graph">Graph</button><button class="tab${boardOn}" type="button" data-action="epic-view" data-mode="board">Board</button></div>`
    : "";
  const state = selected.delegated
    ? statePill(selected.state === "done" ? "merged" : selected.state, epicLabel(selected.state))
    : '<span class="tag">Not delegated</span>';
  return `<div class="tabs">${tabs}</div>
    <div class="split"><div>
      <div class="epic-head"><div>
        <div class="row"><span class="lin-id">${esc(selected.id)}</span><span class="tag lin">Linear parent</span>${state}</div>
        <h1>${esc(selected.title)}</h1>
        <div class="muted" style="max-width:640px">${esc(selected.description)}</div>
        <div class="row" style="margin-top:10px;font-size:12px">${avatar(selected.dri, true)} <span class="muted">DRI ${esc(selected.dri)}</span> <span class="dim">·</span> ${linkList(selected.links)}</div>
      </div><div class="row">${toggle}</div></div>
      ${items.length ? (mode === "board" ? board(items) : graph(items)) : `<div class="empty">No items yet.</div>`}
    </div>
    <div class="card lin-panel"><div class="between"><h3 style="margin:0">Linear agent session</h3><span class="tag lin">${esc(selected.id)}</span></div>
      <div class="dim" style="font-size:11.5px;margin:4px 0 8px">What Paws posted on the parent issue.</div>
      <div class="scroll">${session(selected, snapshot.generatedAt)}</div>
    </div></div>`;
}

function viewRuns(snapshot: StatusSnapshot, id: string | null): string {
  const runs = [...snapshot.runs].sort(
    (a, b) => rankRun(a) - rankRun(b) || b.startedAt.localeCompare(a.startedAt),
  );
  const selected = runs.find((run) => run.id === id) ?? runs[0];
  if (!selected) return `<div class="empty">No runs.</div>`;
  const item = findItem(snapshot, selected.itemId);
  const buttons = runs
    .map((run) => {
      const cls = run.id === selected.id ? "btn sm primary" : "btn sm ghost";
      return `<a class="${cls}" href="${routeHref({ view: "runs", id: run.id })}">${esc(run.id)} · ${esc(run.itemId)} ${statePill(run.state, runLabel(run.state))}</a>`;
    })
    .join("");
  const title = item?.title ?? selected.itemId;
  return `<div class="row wrap">${buttons}</div>
    <div class="split" style="margin-top:12px"><div>
      <div class="row">${itemLink(item)}${statePill(selected.state, runLabel(selected.state))}${agentChip(selected.agent)}</div>
      <h1>${esc(title)}</h1>
      <p class="muted">${esc(selected.summary)}</p>
      <div class="log">${selected.activity.map((line) => `<div class="ln ${esc(line.kind)}"><span class="ts">${esc(clock(line.at))}</span><span class="ty">${esc(line.kind)}</span><span class="tx">${esc(line.text)}</span></div>`).join("")}</div>
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
  return `<h1>Open questions</h1>
    <div class="sub">Agents parked these runs. Answers happen in Linear. This page does not send them.</div>
    ${cards || '<div class="empty">No open questions.</div>'}`;
}

function viewVerdicts(snapshot: StatusSnapshot, id: string | null): string {
  const verdicts = snapshot.verdicts;
  const selected = verdicts.find((verdict) => verdict.itemId === id) ?? verdicts[0];
  if (!selected) return `<div class="empty">No Closeout verdicts yet.</div>`;
  const item = findItem(snapshot, selected.itemId);
  const buttons = verdicts
    .map((verdict) => {
      const cls = verdict.itemId === selected.itemId ? "btn sm primary" : "btn sm ghost";
      return `<a class="${cls}" href="${routeHref({ view: "verdicts", id: verdict.itemId })}">${esc(verdict.itemId)} <span class="dim">·</span> ${esc(verdict.decision)}</a>`;
    })
    .join("");
  const bars = Array.from({ length: selected.maxAttempts }, (_, index) => {
    const n = index + 1;
    const cls = n < selected.attempt ? "f" : n > selected.attempt ? "" : barClass(selected);
    return `<i class="${cls}"></i>`;
  }).join("");
  const fail =
    selected.failingCheck && selected.decision !== "accepted"
      ? `<div class="mono" style="color:#ff9f9f;margin-top:3px">${esc(selected.failingCheck)}</div>`
      : "";
  return `<div class="row wrap">${buttons}</div>
    <div class="between" style="margin:12px 0"><div>
      <div class="row">${itemLink(item)}${item ? statePill(item.state, itemLabel(item.state)) : ""}</div>
      <h1>Closeout · ${esc(item?.title ?? selected.itemId)}</h1>
      <div class="muted">${esc(selected.summary)}</div>
    </div>
    <div style="text-align:right"><div class="muted" style="font-size:12px;margin-bottom:5px">Attempt ${selected.attempt}/${selected.maxAttempts}</div><div class="attempts">${bars}</div></div></div>
    <div class="decision ${esc(selected.decision)}"><div class="big">${esc(verdictLabel(selected.decision))}</div><div class="muted" style="flex:1">${esc(verdictDetail(selected.decision))}${fail}</div></div>
    <div class="card" style="padding:0;margin-top:14px">${checks(selected)}</div>
    <div class="card" style="margin-top:14px"><h3>Report</h3><div class="kv">
      <span class="k">Base</span><span class="mono">${esc(selected.baseSha ?? "—")}</span>
      <span class="k">Head</span><span class="mono">${esc(selected.headSha ?? "—")}</span>
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
    ? `<div class="card" style="margin-top:16px"><h2>Recently merged</h2><div class="tw"><table><tr><th>Item</th><th>PR</th><th class="hide-phone">Agent</th><th>Assignee</th></tr>
        ${merged
          .map(
            (item) =>
              `<tr><td>${itemLink(item)} ${esc(item.title)}</td><td class="mono">${item.pr ? `#${item.pr.number}` : "—"}</td><td class="hide-phone">${agentChip(item.agent)}</td><td>${avatar(item.assignee, true)} ${esc(item.assignee)}</td></tr>`,
          )
          .join("")}
      </table></div></div>`
    : "";
  return `<h1>Merge queue</h1>
    <div class="sub">Serial. Each pull request is rebased onto main and Closeout runs again, because old evidence goes stale on a new base.</div>
    ${body}${recent}`;
}

function epicTable(snapshot: StatusSnapshot): string {
  if (!snapshot.epics.length) return '<div class="empty">No epics.</div>';
  const rows = snapshot.epics
    .map((epic) => {
      const items = snapshot.items.filter((item) => item.epicId === epic.id);
      const merged = items.filter((item) => item.state === "merged").length;
      const width = items.length ? (merged / items.length) * 100 : 0;
      const state = epic.delegated
        ? statePill(epic.state === "done" ? "merged" : epic.state, epicLabel(epic.state))
        : '<span class="tag">Not delegated</span>';
      return `<tr class="click"><td><a href="${routeHref({ view: "epics", id: epic.id })}"><span class="lin-id">${esc(epic.id)}</span> <b>${esc(epic.title)}</b></a></td>
        <td class="hide-phone">${avatar(epic.dri, true)} <span class="muted">${esc(epic.dri)}</span></td>
        <td>${state}</td>
        <td><div class="row"><div class="meter" style="flex:1;margin:0"><i style="width:${width}%"></i></div><span class="muted mono">${merged}/${items.length}</span></div></td></tr>`;
    })
    .join("");
  return `<div class="tw"><table><tr><th>Epic</th><th class="hide-phone">DRI</th><th>Status</th><th>Progress</th></tr>${rows}</table></div>`;
}

function board(items: StatusItem[]): string {
  const columns = ITEM_ORDER.filter((state) => items.some((item) => item.state === state));
  return `<div class="board">${columns
    .map((state) => {
      const group = items.filter((item) => item.state === state);
      return `<div class="col"><div class="between" style="margin-bottom:8px">${statePill(state, itemLabel(state))}<span class="dim mono">${group.length}</span></div>${group.map((item) => node(item, "")).join("")}</div>`;
    })
    .join("")}</div>`;
}

function graph(items: StatusItem[]): string {
  const layout = layoutDag(items);
  const edges = items.flatMap((item) =>
    item.blockers.flatMap((blocker) => {
      const from = layout.pos.get(blocker);
      const to = layout.pos.get(item.id);
      const blockerItem = items.find((candidate) => candidate.id === blocker);
      if (!from || !to || !blockerItem) return [];
      const x1 = from.x + layout.w;
      const y1 = from.y + layout.h / 2;
      const x2 = to.x;
      const y2 = to.y + layout.h / 2;
      const mx = (x1 + x2) / 2;
      const done = blockerItem.state === "merged";
      const color = done ? "#2b7a5e" : "#4b4f63";
      const dash = done ? "" : ' stroke-dasharray="4 4"';
      return [
        `<path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2 - 4},${y2}" fill="none" stroke="${color}" stroke-width="1.6"${dash}/>`,
      ];
    }),
  );
  const nodes = items
    .map((item) => {
      const pos = layout.pos.get(item.id);
      if (!pos) return "";
      return node(item, `left:${pos.x}px;top:${pos.y}px`);
    })
    .join("");
  return `<div class="dag-wrap"><div class="dag" style="width:${layout.width}px;height:${layout.height}px"><svg width="${layout.width}" height="${layout.height}">${edges.join("")}</svg>${nodes}</div></div>
    <div class="legend"><span>Dashed: blocker still open</span><span style="color:#5dd3a3">Solid: blocker merged</span></div>`;
}

function node(item: StatusItem, style: string): string {
  const href = item.runId
    ? routeHref({ view: "runs", id: item.runId })
    : routeHref({ view: "epics", id: item.epicId });
  const positioned = style ? ` style="${style}"` : "";
  return `<a class="node s-${esc(item.state)}" href="${href}"${positioned}>
    <div class="between"><span class="lin-id">${esc(item.id)}</span>${statePill(item.state, itemLabel(item.state))}</div>
    <div class="t" title="${esc(item.title)}">${esc(item.title)}</div>
    <div class="meta"><div class="row">${agentChip(item.agent)}</div><div class="row">${avatar(item.assignee, true)}</div></div>
  </a>`;
}

function layoutDag(items: StatusItem[]): {
  pos: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
  w: number;
  h: number;
} {
  const byId = new Map(items.map((item) => [item.id, item]));
  const level = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    const cached = level.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const blockers = (byId.get(id)?.blockers ?? []).filter((blocker) => byId.has(blocker));
    const value = blockers.length ? 1 + Math.max(...blockers.map(depth)) : 0;
    visiting.delete(id);
    level.set(id, value);
    return value;
  };
  for (const item of items) depth(item.id);
  const columns = new Map<number, StatusItem[]>();
  for (const item of items) {
    const column = level.get(item.id) ?? 0;
    const list = columns.get(column) ?? [];
    list.push(item);
    columns.set(column, list);
  }
  const w = 236;
  const h = 92;
  const pos = new Map<string, { x: number; y: number }>();
  for (const [column, group] of columns) {
    group.forEach((item, index) => {
      pos.set(item.id, { x: 20 + column * (w + 72), y: 20 + index * (h + 18) });
    });
  }
  const columnCount = Math.max(1, columns.size);
  const rowCount = Math.max(1, ...[...columns.values()].map((group) => group.length));
  return { pos, w, h, width: 40 + columnCount * (w + 72), height: 40 + rowCount * (h + 18) };
}

function session(epic: StatusEpic, now: string): string {
  if (!epic.session.length) return '<div class="dim">No session yet.</div>';
  return [...epic.session]
    .reverse()
    .map(
      (note) =>
        `<div class="act"><span class="kind ${esc(note.kind)}">${esc(note.kind)}</span><div><div>${esc(note.text)}</div><div class="dim">${esc(note.actor)} · ${esc(ago(note.at, now))}</div></div></div>`,
    )
    .join("");
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
      <div class="row" style="margin-top:8px"><span class="dim">Read-only.</span> ${linkList(question.links)}</div>
    </div></article>`;
}

function questionRow(snapshot: StatusSnapshot, question: StatusQuestion): string {
  return `<div class="it"><a href="${routeHref({ view: "questions", id: question.id })}"><b>${esc(question.id)}</b> ${esc(question.title)}</a><div class="dim">${esc(question.itemId)} · ${esc(ago(question.askedAt, snapshot.generatedAt))}</div></div>`;
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
      const color =
        event.level === "err"
          ? "color:#ff8f8f"
          : event.level === "ok"
            ? "color:#9fe3c5"
            : event.level === "warn"
              ? "color:#f3d18d"
              : "";
      return `<div class="it row"><span class="mono dim" style="width:72px;flex:none">${esc(clock(event.at))}</span><span style="${color}">${esc(event.text)}</span></div>`;
    })
    .join("");
}

function checks(verdict: StatusVerdict): string {
  return verdict.checks
    .map((check) => {
      const mark =
        check.state === "passed"
          ? "✓"
          : check.state === "failed"
            ? "✕"
            : check.state === "skipped"
              ? "–"
              : "";
      const detail = check.detail ? `<div class="dim">${esc(check.detail)}</div>` : "";
      return `<div class="chk"><span class="ico ${esc(check.state)}">${mark}</span><span class="mono">${esc(check.id)}</span><span><span class="mono muted">${esc(check.command)}</span>${detail}</span><span class="tag">${esc(check.kind)}</span></div>`;
    })
    .join("");
}

function stateStrip(items: StatusItem[]): string {
  const counts = new Map<ItemState, number>();
  for (const item of items) counts.set(item.state, (counts.get(item.state) ?? 0) + 1);
  return ITEM_ORDER.filter((state) => counts.has(state))
    .map(
      (state) =>
        `${statePill(state, itemLabel(state))}<span class="mono dim">${counts.get(state)}</span>`,
    )
    .join("");
}

function stat(label: string, value: string, sub: string, width: number, color: string): string {
  const fill = color ? `background:${color}` : "";
  return `<div class="card stat"><div class="k">${esc(label)}</div><div class="v">${esc(value)}</div><div class="s">${esc(sub)}</div><div class="meter"><i style="width:${Math.max(0, Math.min(100, width))}%;${fill}"></i></div></div>`;
}

function itemLink(item: StatusItem | undefined): string {
  if (!item) return "";
  return `<a class="lin-id" href="${routeHref({ view: "epics", id: item.epicId })}">${esc(item.id)}</a>`;
}

function findItem(snapshot: StatusSnapshot, id: string): StatusItem | undefined {
  return snapshot.items.find((item) => item.id === id);
}

function navCounts(snapshot: StatusSnapshot): Record<Route["view"], number> {
  return {
    overview: 0,
    epics: snapshot.epics.length,
    runs: snapshot.runs.filter((run) => ACTIVE_RUN.has(run.state)).length,
    questions: snapshot.questions.length,
    verdicts: snapshot.verdicts.filter((verdict) => verdict.decision !== "accepted").length,
    queue: snapshot.mergeQueue.length,
  };
}

function routeParam(route: Route): string | null {
  if (route.view === "overview" || route.view === "queue") return null;
  return route.id;
}

function rankRun(run: StatusRun): number {
  return ACTIVE_RUN.has(run.state) ? 0 : 1;
}

function barClass(verdict: StatusVerdict): string {
  if (verdict.decision === "accepted") return "p";
  if (verdict.decision === "running") return "r";
  return "f";
}

function sourcePill(model: RenderModel): string {
  if (model.phase === "loading") return `<span class="pill">Loading</span>`;
  if (model.phase === "error" && !model.snapshot)
    return `<span class="pill demo-pill">Offline</span>`;
  if (model.snapshot?.source === "live") return `<span class="pill live-pill">Live</span>`;
  return `<span class="pill demo-pill" title="Sample data">Demo data</span>`;
}
