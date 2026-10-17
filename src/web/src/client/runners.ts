import { renderMarkup } from "./theme";
import { esc } from "./format";
import { readCsrfToken } from "./github-auth";

/** The runner list refreshes this often while the page is visible. */
export const RUNNER_POLL_MS = 10_000;
/** Runners heartbeat every 15 seconds; four missed beats mark a runner offline. */
export const RUNNER_OFFLINE_MS = 60_000;

type RunnerStatus = "active" | "paused" | "draining" | "revoked";
type Seat = "unknown" | "personal" | "organization" | "api";
export type AgentSignIn = {
  agent: string;
  status: "signed_in" | "signed_out" | "checking" | "usage_limit" | "unknown";
  checkedAt: number | null;
  resetsAt?: number | null;
};
export type Runner = {
  id: string;
  name: string;
  ownerUserId: string;
  status: RunnerStatus;
  metrics: {
    cpuPercent: number | null;
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
  agents?: AgentSignIn[];
};
export type HostPolicy = {
  ownerUserId: string;
  sharing?: number;
  agents: { agent: string; seat: string }[];
};
type Session = { userId: string; role: string; authenticatedAt: number };
type WorkspacePolicy = { personalOrganizationHost: boolean };
type Usage = {
  commandId: string;
  runnerName: string;
  agent: string | null;
  resolvedModel: string | null;
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
const SEATS: readonly [Seat, string][] = [
  ["unknown", "Not declared"],
  ["personal", "Personal subscription"],
  ["organization", "Organization account"],
  ["api", "API account"],
];
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

export function runnerActionsMarkup(
  runner: { id: string; status: RunnerStatus },
  state: { manages: boolean; busy: boolean; recent: boolean },
): string {
  if (!state.manages || runner.status === "revoked") return "";
  const disabled = state.busy || !state.recent ? " disabled" : "";
  const id = esc(runner.id);
  const pause =
    runner.status === "active"
      ? `<button class="btn" data-runner-status="paused" data-runner="${id}" data-focus="status:${id}:toggle"${disabled}>Pause</button>`
      : `<button class="btn" data-runner-status="active" data-runner="${id}" data-focus="status:${id}:toggle"${disabled}>Resume</button>`;
  const drain =
    runner.status !== "draining"
      ? `<button class="btn" data-runner-status="draining" data-runner="${id}" data-focus="status:${id}:draining"${disabled}>Drain</button>`
      : "";
  return `<div class="row">${pause}${drain}<details data-details="revoke:${id}"><summary data-focus="revoke:${id}">Revoke access</summary><p>Disconnect this runner and stop accepting its work.</p><button class="btn" data-runner-status="revoked" data-runner="${id}" data-focus="status:${id}:revoked"${disabled}>Revoke runner</button></details></div>`;
}

/** One always-expanded runner card. */
export function runnerCardMarkup(
  runner: Runner,
  view: {
    now: number;
    serverVersion: string | null;
    policy: HostPolicy | null;
    userId: string | null;
    role: string | null;
    busy: boolean;
    recent: boolean;
    open?: ReadonlySet<string>;
  },
): string {
  const id = esc(runner.id);
  const online = runnerOnline(runner, view.now);
  const metrics = runner.metrics;
  const statusClass =
    runner.status === "revoked"
      ? "bad"
      : runner.status === "draining"
        ? "warn"
        : runner.status === "paused"
          ? "paused"
          : "ok";
  const tags = [
    `<span class="tag ${statusClass}">${esc(runner.status[0]!.toUpperCase() + runner.status.slice(1))}</span>`,
    online ? '<span class="tag ok">Online</span>' : '<span class="tag bad">Offline</span>',
    online
      ? runner.idle
        ? '<span class="tag">Idle</span>'
        : '<span class="tag running">Busy</span>'
      : "",
  ].join("");
  const behind =
    runner.version !== null &&
    view.serverVersion !== null &&
    (compareVersions(runner.version, view.serverVersion) ?? 0) < 0;
  const known = (value: number | null | undefined, format: (value: number) => string) =>
    value === null || value === undefined ? "Not reported" : esc(format(value));
  const memory =
    metrics?.memoryTotalBytes != null && metrics.memoryAvailableBytes != null
      ? `${bytes(metrics.memoryTotalBytes - metrics.memoryAvailableBytes)} used of ${bytes(metrics.memoryTotalBytes)}`
      : null;
  const disk =
    metrics?.diskTotalBytes != null && metrics.diskFreeBytes != null
      ? `${bytes(metrics.diskFreeBytes)} free of ${bytes(metrics.diskTotalBytes)}`
      : null;
  const load =
    metrics?.load1 != null
      ? [metrics.load1, metrics.load5, metrics.load15]
          .map((value) => (value === null ? "–" : value.toFixed(2)))
          .join(" / ")
      : null;
  const os = [runner.os?.id, runner.os?.version].filter(Boolean).join(" ");
  const facts = [
    [
      "Version",
      `${runner.version ? esc(runner.version) : "Not reported"}${behind ? ` <span class="tag warn">Update available</span>` : ""}`,
    ],
    [
      "Last seen",
      metrics
        ? `<span title="${esc(new Date(metrics.reportedAt).toLocaleString())}">${esc(seenLabel(metrics.reportedAt, view.now))}</span>`
        : "Never",
    ],
    ["OS", os ? esc(os) : "Not reported"],
    ["CPU", known(metrics?.cpuPercent, (value) => `${Math.round(value)}%`)],
    ["Memory", memory ? esc(memory) : "Not reported"],
    ["Load", load ? esc(load) : "Not reported"],
    ["Disk", disk ? esc(disk) : "Not reported"],
  ]
    .map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`)
    .join("");
  const revoked = runner.status === "revoked";
  const owns =
    view.policy !== null &&
    view.userId === view.policy.ownerUserId &&
    view.role !== null &&
    view.role !== "observer" &&
    !revoked;
  const editable = owns && !view.busy && view.recent ? "" : " disabled";
  const signIns = runner.agents?.length
    ? runner.agents
    : AGENTS.map((agent): AgentSignIn => ({ agent, status: "unknown", checkedAt: null }));
  const agents = signIns
    .map((entry) => {
      const label = AGENT_LABELS[entry.agent] ?? entry.agent;
      const [tone, text] = SIGN_IN[entry.status] ?? SIGN_IN.unknown;
      const seat =
        view.policy?.agents.find((value) => value.agent === entry.agent)?.seat ?? "unknown";
      const resets =
        entry.status === "usage_limit" && entry.resetsAt
          ? ` <span class="muted">Resets ${esc(new Date(entry.resetsAt).toLocaleString())}</span>`
          : "";
      const account =
        view.policy === null || revoked
          ? ""
          : `<label class="field"><span>${esc(label)} account type</span><select data-runner-seat="${id}" data-agent="${esc(entry.agent)}" data-focus="seat:${id}:${esc(entry.agent)}"${editable}>${SEATS.map(([value, name]) => `<option value="${value}"${value === seat ? " selected" : ""}>${name}</option>`).join("")}</select></label>`;
      return `<li><div class="row"><b>${esc(label)}</b><span class="tag ${tone}">${text}</span>${resets}</div>${account}</li>`;
    })
    .join("");
  const sharing =
    view.policy === null || revoked
      ? ""
      : `<label class="runner-consent"><input type="checkbox" data-runner-sharing="${id}" data-focus="sharing:${id}"${view.policy.sharing ? " checked" : ""}${editable}><span>Share this host with members of the same Linear project</span></label>${owns ? (view.recent ? "" : '<p><a href="/auth/linear">Sign in again</a> to change these settings.</p>') : '<p class="muted">The host owner controls its sharing settings.</p>'}`;
  return `<li data-runner-card="${id}"><section class="runner-section" aria-labelledby="runner-${id}-name"><div class="between"><h2 id="runner-${id}-name">${esc(runner.name)}</h2><div class="row">${tags}</div></div><p class="muted"><code>${id}</code></p><dl class="kv">${facts}</dl><h3>Agents</h3><ul class="runner-agents">${agents}</ul>${sharing}${runnerActionsMarkup(
    runner,
    {
      manages: view.role === "owner" || view.role === "admin",
      busy: view.busy,
      recent: view.recent,
    },
  )}</section></li>`;
}

export function createRunners() {
  let root: HTMLElement | null = null;
  let runners: Runner[] = [];
  let serverVersion: string | null = null;
  let policies = new Map<string, HostPolicy>();
  let session: Session | null = null;
  let workspacePolicy: WorkspacePolicy | null = null;
  let setupRequired = false;
  let workspaceReady = false;
  let usage: Usage[] = [];
  let inspection: Inspection | null = null;
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
  let stopPolling: (() => void) | null = null;

  function manages() {
    return session !== null && ["owner", "admin"].includes(session.role);
  }
  function recent() {
    return (
      session !== null &&
      session.authenticatedAt <= Date.now() &&
      Date.now() - session.authenticatedAt <= 15 * 60_000
    );
  }
  function reset() {
    session = null;
    runners = [];
    policies = new Map();
    serverVersion = null;
    workspacePolicy = null;
    usage = [];
    inspection = null;
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
      const [identity, policy, activity, hosts] = await Promise.all([
        api<Session>("/api/auth/session"),
        api<WorkspacePolicy>("/api/runners/policy"),
        api<{ usage: Usage[] }>("/api/runners/usage"),
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
      serverVersion = list.serverVersion ?? null;
      policies = new Map(hosts.filter((entry) => entry !== null));
      session = identity;
      workspacePolicy = policy;
      usage = activity.usage;
      stale = "";
      if (!manages()) inspection = null;
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
    if (
      (administrator ? !manages() : session === null || session.role === "observer") ||
      !recent()
    ) {
      error = "Sign in again with permission to update these runner settings.";
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
  function workspacePolicyView() {
    if (session?.role !== "owner" || !workspacePolicy) return "";
    return `<details class="runner-section" data-details="workspace-policy"><summary data-focus="summary:workspace-policy">Workspace execution permission</summary><form id="workspace-runner-policy"><fieldset${busy || !recent() ? " disabled" : ""}><label class="runner-consent"><input name="personalOrganizationHost" type="checkbox" data-focus="workspace-policy"${workspacePolicy.personalOrganizationHost ? " checked" : ""}><span>Allow personal subscriptions on workspace hosts</span></label><button class="btn" type="submit">Save workspace permission</button></fieldset></form></details>`;
  }
  function usageView() {
    return `<details class="runner-section" data-details="usage"><summary data-focus="summary:usage">Recent execution</summary>${
      usage.length
        ? `<ul class="runner-checks">${usage
            .slice(0, 30)
            .map(
              (entry) =>
                `<li><b>${esc(entry.runnerName)} · ${esc(entry.purpose)}</b><p>${esc(entry.agent ?? "Checks")}${entry.resolvedModel ? ` · ${esc(entry.resolvedModel)}` : ""} · ${esc(entry.outcome?.replaceAll("_", " ") ?? "Running")}</p><p class="muted">${esc(new Date(entry.startedAt).toLocaleString())}${entry.endedAt === null ? "" : ` · ${Math.max(0, Math.round((entry.endedAt - entry.startedAt) / 1000))} seconds`}</p></li>`,
            )
            .join("")}</ul>`
        : '<p class="muted">No execution has been recorded yet.</p>'
    }</details>`;
  }
  function markup(open: ReadonlySet<string>): string {
    if (setupRequired)
      return `<h1 class="sr-only">Runners</h1><p class="sub">Connect a Linux host to execute work delegated in Linear.</p><section class="runner-section" aria-labelledby="runner-setup-heading"><h2 id="runner-setup-heading">Set up remote runners</h2><p>Enable secure runner access on your Paws server to pair a host.</p><ol>${workspaceReady ? "" : '<li>Configure workspace sign-in over HTTPS. <a href="https://github.com/pmdroid/paws-app/blob/main/docs/workspace-access.md" target="_blank" rel="noopener noreferrer">Open the workspace setup guide</a>.</li>'}<li>Initialize the runner identity once on the Paws server: <code>bun run paws runner-authority init</code>.</li><li>Enable the runner listener with <code>PAWS_RUNNER_HOST</code>, then restart Paws with your HTTPS workspace configuration.</li><li>On the Linux host, install the runner: <code>curl -fsSL https://get.paws.boo/ | sudo sh</code>.</li></ol><p>Sign in as a workspace owner or admin to approve the host's pairing code.</p><button class="btn" data-runners-setup data-focus="setup"${busy ? " disabled" : ""}>${busy ? "Checking setup…" : "Check setup"}</button>${error ? `<p role="alert" class="err">${esc(error)}</p>` : ""}</section>`;
    const disabled = busy || !recent() ? " disabled" : "";
    const now = Date.now();
    const cards = runners
      .map((runner) =>
        runnerCardMarkup(runner, {
          now,
          serverVersion,
          policy: policies.get(runner.id) ?? null,
          userId: session?.userId ?? null,
          role: session?.role ?? null,
          busy,
          recent: recent(),
        }),
      )
      .join("");
    const html = `<h1 class="sr-only">Runners</h1><p class="sub">Manage the Linux hosts that execute work delegated in Linear. Status refreshes every 10 seconds.</p>${error ? `<p role="alert" class="err">${esc(error)}</p>` : ""}${stale ? `<p class="muted">${esc(stale)}</p>` : ""}<p role="status">${busy && !runners.length ? "Loading runners…" : esc(feedback)}</p>${manages() && !recent() ? '<p><a href="/auth/linear">Sign in again</a> to manage runners.</p>' : ""}${manages() ? `<section class="runner-section"><h2>Pair a host</h2><p>On the Linux host, run <code>curl -fsSL https://get.paws.boo/ | sudo sh</code>.</p><form id="runner-pairing"><label class="field"><span>Pairing code from the host</span><input name="code" data-focus="code" required pattern="[A-Fa-f0-9]{16}" maxlength="16" autocomplete="off" spellcheck="false" value="${esc(code)}"${disabled}></label><button class="btn" type="submit" data-focus="inspect"${disabled}>Inspect host</button></form>${inspection ? `<div id="runner-inspection"><h3>${esc(inspection.name)}</h3><p>Compare this request fingerprint with the host before approving.</p><code>${esc(inspection.requestFingerprint)}</code><p class="muted">Expires ${esc(new Date(inspection.expiresAt).toLocaleTimeString())}</p><button class="btn primary" data-runner-approve data-focus="approve"${disabled}>Approve runner</button></div>` : ""}</section>` : ""}${runners.length ? `<ul class="runner-list">${cards}</ul>` : ""}${!busy && !runners.length && !error ? "<p>No runners are paired. On the Linux host, run <code>curl -fsSL https://get.paws.boo/ | sudo sh</code> and enter its pairing code.</p>" : ""}${workspacePolicyView()}${usageView()}`;
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
  function savePolicy(runnerId: string, body: { agent: string; seat: string; sharing: boolean }) {
    void change(async () => {
      await api(`/api/runners/${encodeURIComponent(runnerId)}/policy`, body);
      feedback = "Host settings saved.";
    }, false);
  }
  function bind() {
    root!.querySelector("[data-runners-setup]")?.addEventListener("click", () => void load());
    for (const select of root!.querySelectorAll<HTMLSelectElement>("select[data-runner-seat]"))
      select.addEventListener("change", () => {
        const runnerId = select.dataset.runnerSeat!;
        savePolicy(runnerId, {
          agent: select.dataset.agent!,
          seat: select.value,
          sharing: Boolean(policies.get(runnerId)?.sharing),
        });
      });
    for (const box of root!.querySelectorAll<HTMLInputElement>("input[data-runner-sharing]"))
      box.addEventListener("change", () => {
        const runnerId = box.dataset.runnerSharing!;
        const seats = policies.get(runnerId)?.agents ?? [];
        const target = box.checked
          ? seats.find((entry) => entry.seat === "organization" || entry.seat === "api")
          : (seats[0] ?? { agent: "claude", seat: "unknown" });
        if (!target) {
          error = "Sharing requires an organization or API account. Choose one for an agent first.";
          painted = "";
          paint();
          return;
        }
        savePolicy(runnerId, { agent: target.agent, seat: target.seat, sharing: box.checked });
      });
    root!
      .querySelector<HTMLFormElement>("#workspace-runner-policy")
      ?.addEventListener("submit", (event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget as HTMLFormElement);
        void change(async () => {
          await api("/api/runners/policy", {
            personalOrganizationHost: data.has("personalOrganizationHost"),
          });
          feedback = "Workspace execution permission saved.";
        });
      });
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
          feedback = "Runner approved. The host can complete pairing.";
        }),
    );
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
    mount(element: HTMLElement, engine: string | null, source: string | undefined) {
      const nextConnection = `${engine}:${source}`;
      if (root === element && connection === nextConnection) return;
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
