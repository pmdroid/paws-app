import { renderMarkup } from "./theme";
import { durationLabel, esc, statePill } from "./format";
import { readCsrfToken } from "./github-auth";
import { openAgentAccounts } from "./agent-accounts";
import { routeHref } from "./route";

/** The runner list refreshes this often while the page is visible. */
export const RUNNER_POLL_MS = 10_000;
/** Runners heartbeat this often. */
export const RUNNER_HEARTBEAT_MS = 15_000;
/** Four missed beats mark a runner offline. */
export const RUNNER_OFFLINE_MS = 4 * RUNNER_HEARTBEAT_MS;
/** Host metrics older than two heartbeats are shown as stale. */
export const RUNNER_STALE_MS = 2 * RUNNER_HEARTBEAT_MS;

type RunnerStatus = "active" | "paused" | "draining" | "revoked";
export type AgentSignIn = {
  agent: string;
  status: "signed_in" | "signed_out" | "checking" | "usage_limit" | "unknown";
  checkedAt: number | null;
  resetsAt?: number | null;
  limits?: AgentLimit[];
};
export type AgentLimit = { window: string; usedPercent: number; resetsAt: number | null };
export type Runner = {
  id: string;
  name: string;
  ownerUserId: string;
  status: RunnerStatus;
  metrics: {
    cpuPercent: number | null;
    /** Online CPUs; older runners do not report it. */
    cpuCount?: number | null;
    memoryTotalBytes: number | null;
    memoryAvailableBytes: number | null;
    load1: number | null;
    load5: number | null;
    load15: number | null;
    diskTotalBytes: number | null;
    diskFreeBytes: number | null;
    reportedAt: number;
  } | null;
  os: { id: string | null; version: string | null } | null;
  version: string | null;
  idle: boolean;
  slots?: { used: number; total: number };
  /** Desired is chosen in Paws; applied and ceiling are what the runner last reported. */
  concurrency?: { desired: number | null; applied: number; ceiling: number | null } | null;
  agents?: AgentSignIn[];
  /** Sessions with a live work lease on this runner, oldest first. */
  running?: RunningSession[];
};
export type RunningSession = {
  runId: string;
  identifier: string;
  title: string;
  phase: "working" | "closeout" | "fixing" | "merging";
  startedAt: number;
};
export type HostPolicy = {
  ownerUserId: string;
  sharing?: number;
};
type Session = { userId: string; role: string };
export type Usage = {
  commandId: string;
  runnerId: string;
  runnerName: string;
  runId: string | null;
  agent: string | null;
  resolvedModel: string | null;
  /** The model entry's label, such as "Opus 5.5 · 1M context". */
  modelLabel?: string | null;
  purpose: string;
  outcome: string | null;
  startedAt: number;
  endedAt: number | null;
};
type Inspection = {
  code: string;
  name: string;
  requestFingerprint: string;
  expiresAt: number;
};
type Timers = {
  setInterval: (handler: () => void, ms: number) => unknown;
  clearInterval: (id: never) => void;
};
type Visibility = Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;

const AGENTS = ["claude", "codex", "grok"] as const;
const AGENT_LABELS: Record<string, string> = { claude: "Claude", codex: "Codex", grok: "Grok" };
const SIGN_IN: Record<AgentSignIn["status"], [string, string]> = {
  signed_in: ["ok", "Signed in"],
  signed_out: ["bad", "Signed out"],
  checking: ["running", "Checking"],
  usage_limit: ["warn", "Usage limit"],
  unknown: ["", "Not checked"],
};

/** Runs `tick` every `every` ms while the document is visible, and at once when it becomes visible. */
export function livePoll(
  tick: () => void,
  visibility: Visibility = document,
  timers: Timers = globalThis as unknown as Timers,
  every = RUNNER_POLL_MS,
): () => void {
  const interval = timers.setInterval(() => {
    if (visibility.visibilityState === "visible") tick();
  }, every);
  const onVisibility = () => {
    if (visibility.visibilityState === "visible") tick();
  };
  visibility.addEventListener("visibilitychange", onVisibility);
  return () => {
    timers.clearInterval(interval as never);
    visibility.removeEventListener("visibilitychange", onVisibility);
  };
}

/** Negative when `a` is older than `b`; null when either is not a dotted version. */
export function compareVersions(a: string, b: string): number | null {
  const parts = (value: string) => /^\D*(\d+(?:\.\d+)*)/.exec(value)?.[1]?.split(".").map(Number);
  const left = parts(a);
  const right = parts(b);
  if (!left || !right) return null;
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function runnerOnline(runner: Runner, now: number): boolean {
  const seen = runner.metrics?.reportedAt;
  return runner.status !== "revoked" && seen !== undefined && now - seen <= RUNNER_OFFLINE_MS;
}

function bytes(value: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

function seenLabel(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ago`;
  return new Date(at).toLocaleString();
}

function updateAvailable(runner: Runner, serverVersion: string | null): boolean {
  return (
    runner.version !== null &&
    serverVersion !== null &&
    (compareVersions(runner.version, serverVersion) ?? 0) < 0
  );
}

function availability(runner: Runner, now: number): [string, string] {
  if (runner.status === "revoked") return ["bad", "Revoked"];
  if (!runnerOnline(runner, now)) return ["bad", "Offline"];
  const running = runner.running?.length ?? 0;
  if (running) return ["running", `Running ${running}`];
  return runner.idle ? ["ok", "Idle"] : ["running", "Busy"];
}

export function runnerRowMarkup(
  runner: Runner,
  view: { now: number; serverVersion: string | null },
): string {
  const id = esc(runner.id);
  const [tone, state] = availability(runner, view.now);
  const agents = runner.agents ?? [];
  const signedIn = agents
    .filter((entry) => entry.status === "signed_in")
    .map((entry) => AGENT_LABELS[entry.agent] ?? entry.agent);
  const tags = [
    `<span class="tag ${tone}">${state}</span>`,
    runner.status === "paused" || runner.status === "draining"
      ? `<span class="tag ${runner.status === "paused" ? "paused" : "warn"}">${runner.status === "paused" ? "Paused" : "Draining"}</span>`
      : "",
    ...agents
      .filter((entry) => entry.status === "signed_out" || entry.status === "usage_limit")
      .map(
        (entry) =>
          `<span class="tag ${entry.status === "signed_out" ? "bad" : "warn"}">${esc(AGENT_LABELS[entry.agent] ?? entry.agent)} ${entry.status === "signed_out" ? "signed out" : "usage limit"}</span>`,
      ),
    updateAvailable(runner, view.serverVersion)
      ? '<span class="tag warn">Update available</span>'
      : "",
  ].join("");
  const os = [runner.os?.id, runner.os?.version].filter(Boolean).join(" ");
  const meta = [
    runner.metrics
      ? `Seen ${seenLabel(runner.metrics.reportedAt, view.now).replace(/^Just now$/, "just now")}`
      : "Never reported",
    os,
    runner.version ? `Runner ${runner.version}` : "",
    runner.slots && runner.status !== "revoked"
      ? `${runner.slots.used} of ${runner.slots.total} slots in use`
      : "",
    runner.status === "revoked"
      ? ""
      : signedIn.length
        ? `${signedIn.join(", ")} signed in`
        : "No agent signed in",
  ]
    .filter(Boolean)
    .map(esc)
    .join(" · ");
  return `<li data-runner-row="${id}"><a class="runner-row" href="${esc(routeHref({ view: "runners", id: runner.id }))}" data-focus="open:${id}"><span class="runner-row-name"><b>${esc(runner.name)}</b><span class="muted">${meta}</span></span><span class="runner-row-tags">${tags}</span></a></li>`;
}

const PURPOSES: Record<string, string> = {
  prepare: "Prepare",
  work: "Work",
  check: "Checks",
  helper: "Helper",
};

export function runnerHistoryMarkup(usage: Usage[]): string {
  if (!usage.length) return '<p class="muted">This runner has not executed any work yet.</p>';
  const rows = usage
    .map((entry) => {
      const purpose = esc(PURPOSES[entry.purpose] ?? entry.purpose);
      const work = entry.runId
        ? `<a href="${esc(routeHref({ view: "runs", id: entry.runId }))}">${purpose}</a>`
        : purpose;
      const agent = entry.agent ? (AGENT_LABELS[entry.agent] ?? entry.agent) : "None";
      const outcome =
        entry.outcome === null
          ? '<span class="tag running">Running</span>'
          : `<span class="tag ${entry.outcome === "success" ? "ok" : entry.outcome === "cancelled" ? "warn" : "bad"}">${esc(entry.outcome[0]!.toUpperCase() + entry.outcome.slice(1).replaceAll("_", " "))}</span>`;
      const duration =
        entry.endedAt === null ? "Running" : durationLabel(entry.endedAt - entry.startedAt);
      return `<tr><td><span title="${esc(new Date(entry.startedAt).toLocaleString())}">${esc(new Date(entry.startedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }))}</span></td><td>${work}</td><td>${esc(agent)}${entry.resolvedModel ? `<p class="muted">${esc(entry.modelLabel ?? entry.resolvedModel)}</p>` : ""}</td><td class="hide-phone">${esc(duration)}</td><td>${outcome}</td></tr>`;
    })
    .join("");
  return `<table class="runner-history"><thead><tr><th>Started</th><th>Task</th><th>Agent</th><th class="hide-phone">Duration</th><th>Outcome</th></tr></thead><tbody>${rows}</tbody></table>`;
}

const PHASES: Record<RunningSession["phase"], [string, string]> = {
  working: ["running", "Working"],
  closeout: ["verifying", "Closeout"],
  fixing: ["warn", "Fixing"],
  merging: ["now", "Merging"],
};

function elapsedLabel(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
}

/** One row per busy slot with the session it holds, then one row for the free slots. */
export function runnerRunningMarkup(
  sessions: readonly RunningSession[],
  now: number,
  slots?: { used: number; total: number },
): string {
  const total = Math.max(slots?.total ?? 0, sessions.length);
  const free = total - Math.max(slots?.used ?? 0, sessions.length);
  if (!sessions.length && !slots?.used && free <= 0) return '<p class="muted">Nothing running</p>';
  const full = total > 0 && free <= 0;
  const rows = sessions
    .map((session) => {
      const [tone, phase] = PHASES[session.phase] ?? PHASES.working;
      return `<li class="slot-row" data-running-run="${esc(session.runId)}"><span class="slot-mark used${full ? " high" : ""}" aria-hidden="true"></span><span class="lin-id">${esc(session.identifier)}</span><a class="work-title" href="${esc(routeHref({ view: "runs", id: session.runId }))}">${esc(session.title)}</a><span class="slot-facts">${statePill(tone, phase)}<span class="muted" title="Started ${esc(new Date(session.startedAt).toLocaleString())}">${esc(elapsedLabel(now - session.startedAt))}</span></span></li>`;
    })
    .join("");
  const other = Math.max(0, (slots?.used ?? 0) - sessions.length);
  const busy = other
    ? `<li class="slot-row"><span class="slot-mark used${full ? " high" : ""}" aria-hidden="true"></span><span class="muted">${other} ${sessions.length ? "more " : ""}${other === 1 ? "slot" : "slots"} busy</span></li>`
    : "";
  const idle =
    free > 0
      ? `<li class="slot-row"><span class="slot-mark" aria-hidden="true"></span><span class="muted">${free === total ? "Nothing running · " : ""}${free} ${free === 1 ? "slot" : "slots"} free</span></li>`
      : "";
  return `<ul class="slot-list" role="list" aria-label="Slots">${rows}${busy}${idle}</ul>`;
}

export function runnerActionsMarkup(
  runner: { id: string; status: RunnerStatus },
  state: { manages: boolean; busy: boolean },
  copy = "",
): string {
  if (!state.manages || runner.status === "revoked")
    return copy ? `<div class="row">${copy}</div>` : "";
  const disabled = state.busy ? " disabled" : "";
  const id = esc(runner.id);
  const drain =
    runner.status !== "draining"
      ? `<button class="btn" data-runner-status="draining" data-runner="${id}" data-focus="status:${id}:draining"${disabled}>Drain</button>`
      : "";
  return `<div class="row">${copy}${drain}<details data-details="revoke:${id}"><summary data-focus="revoke:${id}">Revoke access</summary><p>Disconnect this runner and stop accepting its work.</p><button class="btn" data-runner-status="revoked" data-runner="${id}" data-focus="status:${id}:revoked"${disabled}>Revoke runner</button></details></div>`;
}

function pauseMarkup(runner: Runner, state: { manages: boolean; busy: boolean }): string {
  if (!state.manages || runner.status === "revoked") return "";
  const id = esc(runner.id);
  const [next, label] = runner.status === "active" ? ["paused", "Pause"] : ["active", "Resume"];
  return `<button class="btn" data-runner-status="${next}" data-runner="${id}" data-focus="status:${id}:toggle"${state.busy ? " disabled" : ""}>${label}</button>`;
}

/** The concurrency field for owners and admins, or the values for everyone else. */
export function runnerConcurrencyMarkup(
  runner: Runner,
  state: { manages: boolean; busy: boolean; draft?: string },
): string {
  const concurrency = runner.concurrency;
  if (!concurrency || runner.status === "revoked") return "";
  const { desired, applied, ceiling } = concurrency;
  const value = Math.min(desired ?? applied, ceiling ?? 16);
  const id = esc(runner.id);
  const reported =
    ceiling === null
      ? "Set in the host config. Update the runner to change it here."
      : `Host limit ${ceiling}. Runner applied ${applied}.`;
  if (!state.manages || ceiling === null)
    return `${esc(String(value))} <span class="muted">${esc(reported)}</span>`;
  const disabled = state.busy ? " disabled" : "";
  return `<form class="row" data-runner-concurrency="${id}"><input class="concurrency-input" name="concurrency" inputmode="numeric" pattern="[0-9]*" maxlength="2" size="3" required aria-label="Concurrency, from 1 to ${ceiling}" value="${esc(state.draft ?? String(value))}" data-focus="concurrency:${id}"${disabled}><button class="btn" type="submit" data-focus="concurrency:${id}:save"${disabled}>Save</button><span class="muted">${esc(reported)}</span></form>`;
}

/** "5 s ago", "3 min ago", "2 h ago", or the date for older values. */
export function updatedLabel(at: number, now: number): string {
  const seconds = Math.floor(Math.max(0, now - at) / 1000);
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 60 * 60) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 24 * 60 * 60) return `${Math.floor(seconds / 3600)} h ago`;
  return new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

type Gauge = { label: string; value: string; detail?: string; fill?: number; high: boolean };

function gaugeMarkup(gauge: Gauge): string {
  const level = gauge.high ? "high" : "normal";
  const bar =
    gauge.fill === undefined
      ? ""
      : `<span class="gauge" data-fill="${Math.round(Math.min(100, Math.max(0, gauge.fill)))}" data-level="${level}" aria-hidden="true"></span>`;
  const value = gauge.high
    ? `<span class="gauge-value high">${esc(gauge.value)}<span class="sr-only">, high</span></span>`
    : `<span class="gauge-value">${esc(gauge.value)}</span>`;
  return `<div class="runner-gauge" data-gauge="${esc(gauge.label.toLowerCase())}" data-level="${level}"><dt>${esc(gauge.label)}</dt><dd>${value}</dd><dd class="gauge-bar">${bar}</dd>${gauge.detail ? `<dd class="muted">${esc(gauge.detail)}</dd>` : ""}</div>`;
}

/** CPU, memory, disk and load from the latest heartbeat only, as bars that turn orange when high. */
export function runnerMetricsMarkup(metrics: Runner["metrics"], now: number): string {
  if (!metrics)
    return '<section class="runner-host" aria-label="Host metrics"><p class="muted">This runner has not reported host metrics yet.</p></section>';
  const stale = now - metrics.reportedAt > RUNNER_STALE_MS;
  const missing = (label: string): Gauge => ({ label, value: "Not reported", high: false });
  const share = (label: string, total: number | null, free: number | null, detail: string) => {
    if (total === null || free === null || total <= 0) return missing(label);
    const used = Math.min(100, Math.max(0, ((total - free) / total) * 100));
    return { label, value: `${Math.round(used)}%`, detail, fill: used, high: used > 90 };
  };
  const { cpuPercent, cpuCount, load1, load5, load15 } = metrics;
  const gauges: Gauge[] = [
    cpuPercent === null
      ? missing("CPU")
      : {
          label: "CPU",
          value: `${Math.round(cpuPercent)}%`,
          fill: cpuPercent,
          high: cpuPercent > 90,
        },
    share(
      "Memory",
      metrics.memoryTotalBytes,
      metrics.memoryAvailableBytes,
      metrics.memoryTotalBytes !== null && metrics.memoryAvailableBytes !== null
        ? `${bytes(metrics.memoryTotalBytes - metrics.memoryAvailableBytes)} of ${bytes(metrics.memoryTotalBytes)}`
        : "",
    ),
    share(
      "Disk",
      metrics.diskTotalBytes,
      metrics.diskFreeBytes,
      metrics.diskTotalBytes !== null && metrics.diskFreeBytes !== null
        ? `${bytes(metrics.diskFreeBytes)} free of ${bytes(metrics.diskTotalBytes)}`
        : "",
    ),
    load1 === null
      ? missing("Load")
      : cpuCount
        ? {
            label: "Load",
            value: load1.toFixed(2),
            detail: `${cpuCount} ${cpuCount === 1 ? "core" : "cores"}`,
            fill: (load1 / cpuCount) * 100,
            high: load1 > cpuCount,
          }
        : {
            label: "Load",
            value: load1.toFixed(2),
            detail: [
              load5 === null ? "" : `5 min ${load5.toFixed(2)}`,
              load15 === null ? "" : `15 min ${load15.toFixed(2)}`,
            ]
              .filter(Boolean)
              .join(" · "),
            high: false,
          },
  ];
  return `<section class="runner-host" aria-label="Host metrics"${stale ? ' data-stale=""' : ""}><dl class="runner-gauges${stale ? " stale" : ""}">${gauges.map(gaugeMarkup).join("")}</dl></section>`;
}

function resetLabel(at: number, now: number): string {
  const options: Intl.DateTimeFormatOptions =
    at - now < 24 * 60 * 60_000
      ? { hour: "numeric", minute: "2-digit" }
      : { weekday: "short", month: "short", day: "numeric" };
  return `Resets ${new Date(at).toLocaleString([], options)}`;
}

function agentMarkup(entry: AgentSignIn, now: number): string {
  const label = AGENT_LABELS[entry.agent] ?? entry.agent;
  const [tone, text] = SIGN_IN[entry.status] ?? SIGN_IN.unknown;
  const limits = entry.status === "signed_out" ? [] : (entry.limits ?? []);
  const usage = limits.length
    ? `<dl class="agent-limits">${limits
        .map((limit) =>
          gaugeMarkup({
            label: limit.window,
            value: `${Math.round(limit.usedPercent)}% used`,
            fill: limit.usedPercent,
            high: limit.usedPercent >= 90,
            ...(limit.resetsAt ? { detail: resetLabel(limit.resetsAt, now) } : {}),
          }),
        )
        .join("")}</dl>`
    : entry.status === "usage_limit" && entry.resetsAt
      ? `<p class="muted">${esc(resetLabel(entry.resetsAt, now))}</p>`
      : entry.status === "signed_in"
        ? '<p class="muted">Usage not reported</p>'
        : "";
  return `<li class="runner-agent" data-agent="${esc(entry.agent)}"><span class="runner-agent-name"><b>${esc(label)}</b><span class="tag ${tone}">${text}</span></span>${usage}</li>`;
}

function statusLine(runner: Runner, view: { now: number; serverVersion: string | null }): string {
  const [tone, state] = availability(runner, view.now);
  const stale =
    runner.metrics !== null &&
    runnerOnline(runner, view.now) &&
    view.now - runner.metrics.reportedAt > RUNNER_STALE_MS;
  const notes = [
    runner.status === "paused" ? "Paused" : runner.status === "draining" ? "Draining" : "",
    stale ? "Stale" : "",
    updateAvailable(runner, view.serverVersion) ? "Update available" : "",
  ].filter(Boolean);
  return `<p class="runner-status"><span class="tag ${tone}">${esc(state)}</span>${notes.map((note) => `<span>${esc(note)}</span>`).join("")}</p>`;
}

export function runnerDetailMarkup(
  runner: Runner,
  view: {
    now: number;
    serverVersion: string | null;
    policy: HostPolicy | null;
    userId: string | null;
    role: string | null;
    busy: boolean;
    open?: ReadonlySet<string>;
    concurrencyDraft?: string;
  },
): string {
  const id = esc(runner.id);
  const metrics = runner.metrics;
  const revoked = runner.status === "revoked";
  const manages = view.role === "owner" || view.role === "admin";
  const os = [runner.os?.id, runner.os?.version].filter(Boolean).join(" ");
  const meta = [
    runner.version ? `Runner ${runner.version}` : "Version not reported",
    os || "OS not reported",
    metrics ? `Seen ${updatedLabel(metrics.reportedAt, view.now)}` : "Never seen",
  ]
    .map((part) => `<span>${esc(part)}</span>`)
    .join("");
  const owns =
    view.policy !== null &&
    view.userId === view.policy.ownerUserId &&
    view.role !== null &&
    view.role !== "observer" &&
    !revoked;
  const editable = owns && !view.busy ? "" : " disabled";
  const signIns = runner.agents?.length
    ? runner.agents
    : AGENTS.map((agent): AgentSignIn => ({ agent, status: "unknown", checkedAt: null }));
  const signIn =
    revoked || view.role === null || view.role === "observer"
      ? ""
      : `<button class="btn" data-runner-signin="${id}" data-focus="signin:${id}">Sign in to agents</button>`;
  const slots = runner.slots;
  const capacity = slots
    ? `<span class="gauge-value${slots.total > 0 && slots.used >= slots.total ? " high" : ""}">${esc(`${slots.used} of ${slots.total} in use`)}</span>`
    : "";
  const head = `<div class="runner-head"><div class="runner-title"><h2 id="runner-${id}-name">${esc(runner.name)}</h2>${statusLine(runner, view)}<p class="runner-meta" title="${esc(metrics ? new Date(metrics.reportedAt).toLocaleString() : "")}">${meta}</p></div>${pauseMarkup(runner, { manages, busy: view.busy })}</div>`;
  const block = (key: string, title: string, aside: string, body: string) =>
    `<section class="runner-block" aria-labelledby="runner-${id}-${key}"><div class="runner-block-head"><h3 id="runner-${id}-${key}">${title}</h3>${aside}</div>${body}</section>`;
  const card = `<section class="runner-section" data-runner-card="${id}" aria-labelledby="runner-${id}-name">${head}${
    revoked
      ? ""
      : block(
          "slots",
          "Slots",
          capacity,
          runnerRunningMarkup(runner.running ?? [], view.now, slots),
        )
  }${
    revoked
      ? ""
      : block(
          "agents",
          "Agents",
          signIn,
          `<ul class="runner-agent-list" role="list" aria-label="Agent sign-in and usage">${signIns.map((entry) => agentMarkup(entry, view.now)).join("")}</ul>`,
        )
  }${block("host", "Host", "", runnerMetricsMarkup(metrics, view.now))}</section>`;
  const concurrency = runnerConcurrencyMarkup(runner, {
    manages,
    busy: view.busy,
    ...(view.concurrencyDraft === undefined ? {} : { draft: view.concurrencyDraft }),
  });
  const sharing =
    view.policy === null || revoked
      ? ""
      : `<label class="runner-consent"><input type="checkbox" data-runner-sharing="${id}" data-focus="sharing:${id}"${view.policy.sharing ? " checked" : ""}${editable}><span>Share this host with members of the same Linear project</span></label>${owns ? "" : '<p class="muted">The host owner controls its sharing settings.</p>'}`;
  const copy = `<button class="btn" data-runner-copy="${id}" data-focus="copy:${id}" title="${id}" aria-label="Copy runner ID ${id}">Copy ID</button>`;
  const settings = [
    concurrency
      ? `<div class="runner-setting"><h3>Concurrency</h3><div>${concurrency}</div></div>`
      : "",
    sharing ? `<div class="runner-setting"><h3>Sharing</h3><div>${sharing}</div></div>` : "",
    runnerActionsMarkup(runner, { manages, busy: view.busy }, copy),
  ].join("");
  return `${card}<section class="runner-section" aria-labelledby="runner-${id}-settings"><h2 id="runner-${id}-settings">Settings</h2><div class="runner-settings">${settings}</div></section>`;
}

export function createRunners() {
  let root: HTMLElement | null = null;
  let selected: string | null = null;
  let loaded = false;
  let runners: Runner[] = [];
  let serverVersion: string | null = null;
  let policies = new Map<string, HostPolicy>();
  let session: Session | null = null;
  let setupRequired = false;
  let workspaceReady = false;
  let usage: Usage[] = [];
  let usageRunner: string | null = null;
  let inspection: Inspection | null = null;
  let pairingOpen = false;
  let code = "";
  let busy = false;
  let feedback = "";
  let error = "";
  let stale = "";
  let generation = 0;
  let connection = "";
  let available = false;
  let painted = "";
  let pendingFocus: string | null = null;
  const concurrencyDrafts = new Map<string, string>();
  let stopPolling: (() => void) | null = null;

  function manages() {
    return session !== null && ["owner", "admin"].includes(session.role);
  }
  function reset() {
    session = null;
    loaded = false;
    runners = [];
    policies = new Map();
    serverVersion = null;
    usage = [];
    usageRunner = null;
    inspection = null;
    pairingOpen = false;
  }
  async function api<T>(path: string, body?: unknown): Promise<T> {
    if (!available) throw new Error("Connect to your Paws dashboard to see runners.");
    const response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
      headers:
        body === undefined
          ? {}
          : {
              "content-type": "application/json",
              "x-paws-csrf": readCsrfToken(document),
            },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = (await response.json().catch(() => null)) as { error?: string } | null;
    if (!response.ok)
      throw Object.assign(new Error(data?.error ?? `Runner request failed (${response.status}).`), {
        status: response.status,
      });
    return data as T;
  }
  /** A quiet load refreshes in the background without disabling controls. */
  async function load(quiet = false) {
    const current = ++generation;
    const target = selected;
    if (!quiet) {
      busy = true;
      error = "";
      paint();
    }
    try {
      const list = await api<{
        runners: Runner[];
        serverVersion?: string | null;
        setupRequired?: boolean;
        workspaceReady?: boolean;
      }>("/api/runners");
      if (current !== generation) return;
      setupRequired = list.setupRequired === true;
      workspaceReady = list.workspaceReady === true;
      if (setupRequired) {
        reset();
        return;
      }
      const [identity, activity, hosts] = await Promise.all([
        api<Session>("/api/auth/session"),
        target === null
          ? { usage: [] }
          : api<{ usage: Usage[] }>(`/api/runners/usage?runner=${encodeURIComponent(target)}`),
        Promise.all(
          list.runners
            .filter((runner) => runner.status !== "revoked")
            .map((runner) =>
              api<HostPolicy>(`/api/runners/${encodeURIComponent(runner.id)}/policy`).then(
                (value) => [runner.id, value] as const,
                () => null,
              ),
            ),
        ),
      ]);
      if (current !== generation) return;
      runners = list.runners;
      loaded = true;
      serverVersion = list.serverVersion ?? null;
      policies = new Map(hosts.filter((entry) => entry !== null));
      session = identity;
      usage = activity.usage;
      usageRunner = target;
      stale = "";
      if (!manages()) {
        inspection = null;
        pairingOpen = false;
      }
    } catch (caught) {
      if (current !== generation) return;
      const message = caught instanceof Error ? caught.message : "Runners could not be loaded.";
      if (quiet) stale = `Runner status could not be refreshed: ${message}`;
      else error = message;
      if (
        caught instanceof Error &&
        "status" in caught &&
        [401, 403].includes(Number(caught.status))
      ) {
        session = null;
        inspection = null;
        pairingOpen = false;
      }
    } finally {
      if (current === generation) {
        if (!quiet) busy = false;
        paint();
      }
    }
  }
  async function change(action: () => Promise<void>, administrator = true) {
    if (busy) return;
    if (administrator ? !manages() : session === null || session.role === "observer") {
      error = "You do not have permission to update these runner settings.";
      paint();
      return;
    }
    busy = true;
    error = "";
    feedback = "";
    paint();
    try {
      await action();
      await load();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : "The runner change failed.";
    } finally {
      busy = false;
      paint();
    }
  }
  function listView(now: number, disabled: string, status: string): string {
    const rows = runners.map((runner) => runnerRowMarkup(runner, { now, serverVersion })).join("");
    const alert = error ? `<p role="alert" class="err">${esc(error)}</p>` : "";
    const pairing = manages() && pairingOpen;
    const dialog = pairing
      ? `<dialog id="runner-pair-dialog" aria-labelledby="runner-pair-heading"><div class="dialog-body"><div class="between"><h2 id="runner-pair-heading">Pair a host</h2><button class="btn" data-runner-pair-close data-focus="pair-close">Close</button></div><p>On the Linux host, run <code>curl -fsSL https://get.paws.boo/ | sudo sh</code>.</p>${alert}<form id="runner-pairing"><label class="field"><span>Pairing code from the host</span><input name="code" data-focus="code" required pattern="[A-Fa-f0-9]{16}" maxlength="16" autocomplete="off" spellcheck="false" value="${esc(code)}"${disabled}></label><button class="btn" type="submit" data-focus="inspect"${disabled}>Inspect host</button></form>${inspection ? `<div id="runner-inspection"><h3>${esc(inspection.name)}</h3><p>Compare this request fingerprint with the host before approving.</p><code>${esc(inspection.requestFingerprint)}</code><p class="muted">Expires ${esc(new Date(inspection.expiresAt).toLocaleTimeString())}</p><button class="btn primary" data-runner-approve data-focus="approve"${disabled}>Approve runner</button></div>` : ""}</div></dialog>`
      : "";
    const empty = manages()
      ? "<p>No runners are paired. Select <b>Pair a host</b> to connect a Linux host.</p>"
      : "<p>No runners are paired. On the Linux host, run <code>curl -fsSL https://get.paws.boo/ | sudo sh</code> and enter its pairing code.</p>";
    return `<h1 class="sr-only">Runners</h1><div class="between"><p class="sub">The Linux hosts that execute work delegated in Linear. Select a runner for its details and execution history.</p>${manages() ? `<button class="btn primary" data-runner-pair aria-haspopup="dialog" data-focus="pair">Pair a host</button>` : ""}</div>${pairing ? "" : alert}${status}${runners.length ? `<ul class="runner-rows" role="list" aria-label="Runners">${rows}</ul>` : ""}${!busy && !runners.length && !error ? empty : ""}${dialog}`;
  }
  function detailView(id: string, now: number, notices: string): string {
    const list = routeHref({ view: "runners", id: null });
    const back = `<nav class="crumbs" aria-label="Breadcrumb"><a href="${list}" data-focus="back">All runners</a></nav>`;
    const runner = runners.find((entry) => entry.id === id);
    if (!runner)
      return `<h1 class="sr-only">Runners</h1>${back}${notices}${loaded ? `<div class="empty">This runner is not paired with your workspace. <a href="${list}">Choose another runner</a>.</div>` : ""}`;
    return `<h1 class="sr-only">Runners</h1>${back}${notices}${runnerDetailMarkup(runner, {
      now,
      serverVersion,
      policy: policies.get(runner.id) ?? null,
      userId: session?.userId ?? null,
      role: session?.role ?? null,
      busy,
      ...(concurrencyDrafts.has(runner.id)
        ? { concurrencyDraft: concurrencyDrafts.get(runner.id)! }
        : {}),
    })}<section class="runner-section" aria-labelledby="runner-history-heading"><h2 id="runner-history-heading">Execution history</h2>${usageRunner === id ? runnerHistoryMarkup(usage) : '<p class="muted">Loading execution history…</p>'}</section>`;
  }
  function markup(open: ReadonlySet<string>): string {
    if (setupRequired)
      return `<h1 class="sr-only">Runners</h1><p class="sub">Connect a Linux host to execute work delegated in Linear.</p><section class="runner-section" aria-labelledby="runner-setup-heading"><h2 id="runner-setup-heading">Set up remote runners</h2><p>Enable secure runner access on your Paws server to pair a host.</p><ol>${workspaceReady ? "" : '<li>Configure workspace sign-in over HTTPS. <a href="https://github.com/pmdroid/paws-app/blob/main/docs/workspace-access.md" target="_blank" rel="noopener noreferrer">Open the workspace setup guide</a>.</li>'}<li>Initialize the runner identity once on the Paws server: <code>bun run paws runner-authority init</code>.</li><li>Enable the runner listener with <code>PAWS_RUNNER_HOST</code>, then restart Paws with your HTTPS workspace configuration.</li><li>On the Linux host, install the runner: <code>curl -fsSL https://get.paws.boo/ | sudo sh</code>.</li></ol><p>Sign in as a workspace owner or admin to approve the host's pairing code.</p><button class="btn" data-runners-setup data-focus="setup"${busy ? " disabled" : ""}>${busy ? "Checking setup…" : "Check setup"}</button>${error ? `<p role="alert" class="err">${esc(error)}</p>` : ""}</section>`;
    const disabled = busy ? " disabled" : "";
    const now = Date.now();
    const status = `${stale ? `<p class="muted">${esc(stale)}</p>` : ""}<p role="status">${busy && !loaded ? "Loading runners…" : esc(feedback)}</p>`;
    const html =
      selected === null
        ? listView(now, disabled, status)
        : detailView(
            selected,
            now,
            `${error ? `<p role="alert" class="err">${esc(error)}</p>` : ""}${status}`,
          );
    return html.replace(/<details([^>]*) data-details="([^"]+)"/g, (match, before, key) =>
      open.has(key) ? `<details${before} data-details="${key}" open` : match,
    );
  }
  function paint() {
    if (!root?.isConnected) return;
    if (!available) {
      painted = "";
      renderMarkup(
        root,
        '<h1 class="sr-only">Runners</h1><p>Connect to your Paws dashboard to see runners.</p>',
      );
      return;
    }
    const open = new Set(
      [...root.querySelectorAll<HTMLDetailsElement>("details[data-details]")]
        .filter((details) => details.open)
        .map((details) => details.dataset.details!),
    );
    const html = markup(open);
    if (html === painted) return;
    const active = document.activeElement;
    const focused =
      active instanceof HTMLElement && root.contains(active) ? active.dataset.focus : undefined;
    const caret =
      active instanceof HTMLInputElement && active.type !== "checkbox"
        ? { start: active.selectionStart, end: active.selectionEnd }
        : null;
    const key = focused ?? pendingFocus;
    painted = html;
    renderMarkup(root, html);
    bind();
    const target = key
      ? [...root.querySelectorAll<HTMLElement>("[data-focus]")].find(
          (element) => element.dataset.focus === key,
        )
      : undefined;
    if (target && !(target as HTMLButtonElement).disabled) {
      target.focus({ preventScroll: true });
      if (caret && target instanceof HTMLInputElement)
        target.setSelectionRange(caret.start, caret.end);
      pendingFocus = null;
    } else pendingFocus = busy ? (key ?? null) : null;
  }
  function refocus(key: string | null) {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    pendingFocus = key;
  }
  function savePolicy(runnerId: string, body: { sharing: boolean }) {
    void change(async () => {
      await api(`/api/runners/${encodeURIComponent(runnerId)}/policy`, body);
      feedback = "Host settings saved.";
    }, false);
  }
  function bind() {
    root!.querySelector("[data-runners-setup]")?.addEventListener("click", () => void load());
    for (const box of root!.querySelectorAll<HTMLInputElement>("input[data-runner-sharing]"))
      box.addEventListener("change", () =>
        savePolicy(box.dataset.runnerSharing!, { sharing: box.checked }),
      );
    root!.querySelector<HTMLElement>("[data-runner-pair]")?.addEventListener("click", () => {
      pairingOpen = true;
      refocus("code");
      paint();
    });
    const dialog = root!.querySelector<HTMLDialogElement>("#runner-pair-dialog");
    if (dialog) {
      dialog.showModal();
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      dialog.addEventListener("close", () => {
        if (!dialog.isConnected || !pairingOpen) return;
        pairingOpen = false;
        error = "";
        refocus("pair");
        paint();
      });
      dialog.addEventListener("click", (event) => {
        if (event.target === dialog) dialog.close();
      });
      dialog
        .querySelector("[data-runner-pair-close]")
        ?.addEventListener("click", () => dialog.close());
    }
    root!
      .querySelector<HTMLInputElement>('input[name="code"]')
      ?.addEventListener("input", (event) => {
        code = (event.target as HTMLInputElement).value.toUpperCase();
        inspection = null;
        root!.querySelector("#runner-inspection")?.remove();
      });
    root!.querySelector("#runner-pairing")?.addEventListener("submit", (event) => {
      event.preventDefault();
      void change(async () => {
        const result = await api<Omit<Inspection, "code">>("/api/runners/pairings/inspect", {
          code,
        });
        inspection = { ...result, code };
      });
    });
    root!.querySelector("[data-runner-approve]")?.addEventListener(
      "click",
      () =>
        void change(async () => {
          if (inspection === null) return;
          await api("/api/runners/pairings/approve", {
            code: inspection.code,
          });
          inspection = null;
          code = "";
          pairingOpen = false;
          refocus("pair");
          feedback = "Runner approved. The host can complete pairing.";
        }),
    );
    for (const button of root!.querySelectorAll<HTMLElement>("[data-runner-copy]"))
      button.addEventListener("click", () => {
        const value = button.dataset.runnerCopy!;
        // The clipboard API is missing outside secure contexts, so failures say the ID instead.
        void Promise.resolve()
          .then(() => navigator.clipboard.writeText(value))
          .then(
            () => {
              error = "";
              feedback = "Runner ID copied.";
            },
            () => {
              error = `The runner ID could not be copied. It is ${value}.`;
            },
          )
          .finally(paint);
      });
    for (const button of root!.querySelectorAll<HTMLElement>("[data-runner-signin]"))
      button.addEventListener("click", () => {
        const runner = runners.find((entry) => entry.id === button.dataset.runnerSignin);
        if (!runner) return;
        refocus(`signin:${runner.id}`);
        openAgentAccounts(runner, () => void load(true));
      });
    for (const form of root!.querySelectorAll<HTMLFormElement>("form[data-runner-concurrency]")) {
      const runnerId = form.dataset.runnerConcurrency!;
      const input = form.querySelector<HTMLInputElement>('input[name="concurrency"]')!;
      input.addEventListener("input", () => concurrencyDrafts.set(runnerId, input.value));
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const ceiling = runners.find((entry) => entry.id === runnerId)?.concurrency?.ceiling;
        const value = Number(input.value);
        if (
          !/^\d+$/.test(input.value.trim()) ||
          value < 1 ||
          (ceiling != null && value > ceiling)
        ) {
          error = `Concurrency must be from 1 to ${ceiling ?? 16}, the limit set on the host.`;
          paint();
          return;
        }
        void change(async () => {
          await api(`/api/runners/${encodeURIComponent(runnerId)}/concurrency`, {
            concurrency: value,
          });
          concurrencyDrafts.delete(runnerId);
          feedback = "Concurrency saved. The runner applies it to new work at its next heartbeat.";
        });
      });
    }
    for (const button of root!.querySelectorAll<HTMLElement>("[data-runner-status]"))
      button.addEventListener(
        "click",
        () =>
          void change(async () => {
            await api(`/api/runners/${encodeURIComponent(button.dataset.runner!)}/status`, {
              status: button.dataset.runnerStatus,
            });
            feedback = "Runner status updated.";
          }),
      );
  }
  function poll() {
    if (!root?.isConnected) {
      stopPolling?.();
      stopPolling = null;
      return;
    }
    if (!busy) void load(true);
  }
  return {
    mount(
      element: HTMLElement,
      engine: string | null,
      source: string | undefined,
      runnerId: string | null,
    ) {
      const nextConnection = `${engine}:${source}`;
      const moved = selected !== runnerId;
      selected = runnerId;
      if (moved) {
        feedback = "";
        error = "";
      }
      if (root === element && connection === nextConnection) {
        if (moved && available) {
          painted = "";
          void load();
        }
        return;
      }
      root = element;
      connection = nextConnection;
      painted = "";
      available =
        engine !== null && new URL(engine).origin === location.origin && source === "live";
      if (!available) {
        generation++;
        stopPolling?.();
        stopPolling = null;
        reset();
        setupRequired = false;
        workspaceReady = false;
        renderMarkup(
          element,
          '<h1 class="sr-only">Runners</h1><p>Connect to your Paws dashboard to see runners.</p>',
        );
        return;
      }
      stopPolling ??= livePoll(poll);
      void load();
    },
    refresh() {
      if (!busy) return load();
    },
  };
}
