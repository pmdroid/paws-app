import { journalCaught } from "../journal";
import { renderMarkup } from "./theme";
import { durationLabel, esc, skillVersionLabel, statePill } from "./format";
import { readCsrfToken } from "./csrf";
import { openAgentAccounts } from "./agent-accounts";
import { routeHref } from "./route";
import { livePoll } from "./poll";

/** The runner list refreshes this often while the page is visible. */
export const RUNNER_POLL_MS = 10_000;
/** Runners heartbeat this often. */
export const RUNNER_HEARTBEAT_MS = 15_000;
/** Four missed beats mark a runner offline. */
export const RUNNER_OFFLINE_MS = 4 * RUNNER_HEARTBEAT_MS;
/** Runner metrics older than two heartbeats are shown as stale. */
export const RUNNER_STALE_MS = 2 * RUNNER_HEARTBEAT_MS;

type RunnerStatus = "active" | "paused" | "draining" | "revoked";
export type AgentSignIn = {
  agent: string;
  status: "signed_in" | "signed_out" | "checking" | "usage_limit" | "unknown";
  checkedAt: number | null;
  resetsAt?: number | null;
  limits?: AgentLimit[];
  limitsAt?: number;
};
export type AgentLimit = { window: string; usedPercent: number; resetsAt: number | null };
export type Runner = {
  id: string;
  name: string;
  ownerUserId: string;
  /** The owner's display name; older Paws releases do not send it. */
  ownerName?: string | null;
  status: RunnerStatus;
  hasRunWork?: boolean;
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
    /** Processes of the runner user outside any run; older runners do not report them. */
    strayProcesses?: StrayProcess[] | null;
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
  skills?: RunnerSkill[];
  /** Runtimes mise installed for tasks on this runner; older Paws releases do not list them. */
  runtimes?: RunnerRuntime[];
  /** Coding agent versions the runner reports; older Paws releases do not list them. */
  codingAgents?: RunnerCodingAgent[];
};
export type RunnerCodingAgent = {
  agent: string;
  current: string | null;
  pending: {
    version: string;
    status: "requested" | "installing" | "waiting" | "failed";
    sessions: number | null;
    error: string | null;
    requestedAt: number;
  } | null;
  reportedAt: number | null;
};
export type RunnerRuntime = {
  tool: string;
  version: string;
  status: "installed" | "failed";
  error: string | null;
  reportedAt: number;
};
export type RunnerSkill = {
  name: string;
  version: string;
  installedVersion: string | null;
  state: "up_to_date" | "installing" | "out_of_date" | "failed";
  error: string | null;
  waiting?: number | null;
  reportedAt: number | null;
};
/** Per agent: the newest version Paws offers runners, and each version it refused with why. */
export type AgentCatalogEntry = {
  agent: string;
  offered: string | null;
  refused: { version: string; reason: string }[];
  checkedAt: number;
};
export type StrayProcess = { pid: number; name: string; ageSeconds: number; cpuPercent: number };
export type RunningSession = {
  runId: string;
  identifier: string;
  title: string;
  phase: "working" | "closeout" | "fixing" | "merging";
  startedAt: number;
  /** The runner can hand it over now; older Paws releases do not say. */
  movable?: boolean;
  /** Its move off this runner, with the reason it waits or stayed. */
  move?: { status: "moving" | "waiting" | "stayed"; reason: string | null } | null;
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
  identifier?: string | null;
  title?: string | null;
  agent: string | null;
  resolvedModel: string | null;
  /** The model entry's label, such as "Opus 5.5 · 1M context". */
  modelLabel?: string | null;
  purpose: string;
  outcome: string | null;
  startedAt: number;
  endedAt: number | null;
};
/** What Paws returns when a member asks to add a host. */
export type HostEnrollment = {
  token: string;
  expiresAt: number;
  name: string;
  config: {
    controlPlaneUrl: string;
    runnerApiUrl: string;
    allowedRepositories: readonly string[];
  } | null;
};

/** The member's exe.dev VM as `GET /api/runners/vm` describes it. */
type StepState = "done" | "running" | "failed" | "pending";
export type MemberVmDeleteStep = "drain" | "tailnet" | "revoke" | "destroy" | "clear";
export type MemberVm = {
  id: string;
  vmName: string;
  /** The pool chosen in Create VM or moved to. Null: `[member_vm] pool` when it was created. */
  pool?: string | null;
  userId?: string;
  ownerName?: string | null;
  step: "create" | "install" | "enroll" | "health" | "ready";
  failure: string | null;
  runnerId: string | null;
  steps: {
    step: "create" | "install" | "enroll" | "health";
    state: StepState;
    elapsedMs: number | null;
  }[];
  deleting?: {
    step: MemberVmDeleteStep;
    failure: string | null;
    blocked: { itemId: string; identifier: string; title: string }[];
    force: boolean;
    steps: { step: MemberVmDeleteStep; state: StepState; elapsedMs: number | null }[];
  } | null;
};
/** `[member_vm]` in config.toml. A missing field is exe.dev's default. */
export type MemberVmSize = {
  cpu?: number;
  memoryGb?: number;
  diskGb?: number;
  image?: string;
  pool?: string;
};
/** One exe.dev pool from `pool list`, as `GET /api/runners/vm/pools` answers it. */
export type ExeDevPool = { name: string; region: string | null; status: string | null };
/** exe.dev's pools: not loaded yet, listed, or exe.dev's reason it could not list them. */
export type PoolList =
  | { state: "loading" }
  | { state: "listed"; pools: ExeDevPool[] }
  | { state: "failed"; error: string };
export type MemberVmState =
  | { available: false }
  | { available: true; vm: MemberVm | null; vms?: MemberVm[]; size?: MemberVmSize };

/** The size Create VM asks exe.dev for, next to the button. */
export function memberVmSizeMarkup(size: MemberVmSize | undefined): string {
  if (size === undefined) return "";
  const parts = [
    size.cpu === undefined ? "default CPUs" : `${size.cpu} ${size.cpu === 1 ? "CPU" : "CPUs"}`,
    size.memoryGb === undefined ? "default memory" : `${size.memoryGb} GB memory`,
    size.diskGb === undefined ? "default disk" : `${size.diskGb} GB disk`,
    ...(size.image === undefined ? [] : [`image ${size.image}`]),
  ];
  const { pool, ...flags } = size;
  const text = Object.values(flags).every((value) => value === undefined)
    ? "exe.dev's default size"
    : parts.join(" · ");
  const placed =
    pool === undefined
      ? esc("the exe.dev team's default placement")
      : `exe.dev pool <b class="mono">${esc(pool)}</b>`;
  return `<p class="muted" id="vm-create-size">Create VM uses ${esc(text)}, in ${placed}. Change the defaults under <span class="mono">[member_vm]</span> in config.toml.</p>`;
}

function poolLabel(pool: ExeDevPool): string {
  return [pool.name, pool.region, pool.status].filter(Boolean).join(" · ");
}

/** The pool for the next Create VM: `[member_vm] pool` first, then the others from `pool list`. */
export function memberVmPoolMarkup(
  configured: string | undefined,
  pools: PoolList,
  view: { choice: string; busy: boolean },
): string {
  if (pools.state === "loading") return '<p class="muted">Listing exe.dev pools…</p>';
  if (pools.state === "failed")
    return `<p class="muted" data-vm-pools-error>exe.dev pools could not be listed: ${esc(pools.error)}</p>`;
  const others = pools.pools.filter((pool) => pool.name !== configured);
  if (others.length === 0) return "";
  const first =
    configured === undefined ? "Team default placement" : `${configured} ([member_vm] pool)`;
  const options = others
    .map(
      (pool) =>
        `<option value="${esc(pool.name)}"${pool.name === view.choice ? " selected" : ""}>${esc(poolLabel(pool))}</option>`,
    )
    .join("");
  return `<div class="settings-field"><label for="vm-create-pool">Pool for this VM</label><select id="vm-create-pool" data-vm-pool data-focus="vm-pool"${view.busy ? " disabled" : ""}><option value=""${view.choice ? "" : " selected"}>${esc(first)}</option>${options}</select></div>`;
}

/**
 * Move to pool on a VM's runner page: exe.dev's `pool adopt`. Left out once exe.dev refused the
 * token, with exe.dev's words in its place.
 */
export function memberVmMoveMarkup(
  vm: MemberVm,
  pools: PoolList,
  view: { busy: boolean; denied: string | null },
): string {
  if (view.denied !== null)
    return `<p class="muted" data-vm-move-denied>Move to pool is not available: ${esc(view.denied)}</p>`;
  if (pools.state !== "listed" || vm.deleting) return "";
  const others = pools.pools.filter((pool) => pool.name !== vm.pool);
  if (others.length === 0) return "";
  const id = esc(vm.id);
  const disabled = view.busy ? " disabled" : "";
  const options = others
    .map((pool) => `<option value="${esc(pool.name)}">${esc(poolLabel(pool))}</option>`)
    .join("");
  return `<form class="row" data-vm-move="${id}"><label class="sr-only" for="vm-move-${id}">Pool</label><select id="vm-move-${id}" name="pool" data-focus="vm-move:${id}"${disabled}>${options}</select><button class="btn" type="submit" data-focus="vm-move:${id}:save"${disabled}>Move to pool</button></form><p class="muted">exe.dev moves the VM with <span class="mono">pool adopt</span>. The move can take several minutes and needs an exe.dev team admin token.</p>`;
}

const VM_STEPS: Record<MemberVm["steps"][number]["step"], string> = {
  create: "Create the VM",
  install: "Install the runner",
  enroll: "Enroll with Paws",
  health: "First heartbeat",
};
const VM_STATES: Record<MemberVm["steps"][number]["state"], [string, string]> = {
  done: ["ok", "Done"],
  running: ["running", "Running"],
  failed: ["bad", "Failed"],
  pending: ["", "Waiting"],
};

const VM_DELETE_STEPS: Record<MemberVmDeleteStep, string> = {
  drain: "Stop new work",
  tailnet: "Leave the tailnet",
  revoke: "Revoke the runner",
  destroy: "Destroy the VM on exe.dev",
  clear: "Clear the record",
};

function deleteButton(vm: MemberVm, busy: boolean): string {
  return `<button class="btn" data-vm-delete="${esc(vm.id)}" aria-haspopup="dialog" data-focus="vm-delete:${esc(vm.id)}"${busy ? " disabled" : ""}>Delete VM</button>`;
}

export function memberVmDeleteDialogMarkup(vm: MemberVm, view: { busy: boolean }): string {
  const name = esc(vm.vmName);
  const disabled = view.busy ? " disabled" : "";
  return `<dialog id="vm-delete-dialog" aria-labelledby="vm-delete-heading" aria-describedby="vm-delete-detail"><div class="dialog-body"><h2 id="vm-delete-heading">Delete VM <span class="mono">${name}</span>?</h2><p id="vm-delete-detail"><b class="mono">${name}</b> will be destroyed on exe.dev, with everything on its disk, and its runner removed from Paws.</p><p class="muted">An item running on the runner stops the delete and is named here. You can then wait for it or force the delete, which stops the item.</p><div class="settings-actions"><button class="btn" data-vm-delete-cancel data-focus="vm-delete-cancel">Cancel</button><button class="btn primary" data-vm-delete-confirm="${esc(vm.id)}" data-focus="vm-delete-confirm"${disabled}>Delete VM</button></div></div></dialog>`;
}

export function memberVmDeleteMarkup(vm: MemberVm, view: { busy: boolean; title: string }): string {
  const deleting = vm.deleting!;
  const id = esc(vm.id);
  const blocked = deleting.failure !== null && deleting.blocked.length > 0;
  const rows = deleting.steps
    .map((entry) => {
      const [tone, label] = VM_STATES[entry.state];
      const time =
        entry.elapsedMs === null
          ? ""
          : `<span class="muted" data-vm-elapsed>${esc(durationLabel(entry.elapsedMs))}</span>`;
      const error =
        entry.state === "failed" && !blocked
          ? `<p class="runner-skill-error" role="alert">${esc(deleting.failure ?? "The step failed without a reason.")}</p>`
          : "";
      return `<li class="runner-skill" data-vm-delete-step="${esc(entry.step)}" data-vm-state="${esc(entry.state)}"><span class="runner-skill-name"><b>${esc(VM_DELETE_STEPS[entry.step])}</b>${time}</span><span class="tag ${tone}">${esc(blocked && entry.state === "failed" ? "Blocked" : label)}</span>${error}</li>`;
    })
    .join("");
  const disabled = view.busy ? " disabled" : "";
  const tasks = deleting.blocked
    .map((task) => `<li><b class="mono">${esc(task.identifier)}</b> ${esc(task.title)}</li>`)
    .join("");
  const status = blocked
    ? `<div role="alert"><p>${deleting.blocked.length === 1 ? "This item is" : "These items are"} still running on the VM:</p><ul data-vm-delete-blocked>${tasks}</ul><p class="muted">Retry once ${deleting.blocked.length === 1 ? "it ends" : "they end"}, or force the delete. Force delete stops ${deleting.blocked.length === 1 ? "the item" : "each item"} the way Stop does.</p></div>`
    : deleting.failure !== null
      ? '<p class="muted">Retry resumes from the failed step.</p>'
      : '<p class="muted">Paws drains the runner, removes it and destroys the VM on exe.dev.</p>';
  const actions =
    deleting.failure === null
      ? ""
      : `<div class="settings-actions"><button class="btn primary" data-vm-delete-retry="${id}" data-focus="vm-delete-retry:${id}"${disabled}>Retry</button>${blocked && !deleting.force ? `<button class="btn" data-vm-delete-force="${id}" data-focus="vm-delete-force:${id}"${disabled}>Force delete</button>` : ""}</div>`;
  const pill = blocked
    ? '<span class="tag warn">Blocked</span>'
    : deleting.failure !== null
      ? '<span class="tag bad">Delete failed</span>'
      : '<span class="tag running">Deleting</span>';
  return `<section class="runner-section" data-member-vm-delete="${esc(deleting.step)}" aria-labelledby="vm-delete-progress-${id}"><div class="between"><h2 id="vm-delete-progress-${id}" tabindex="-1" data-focus="vm-delete-progress:${id}">${esc(view.title)} <span class="mono">${esc(vm.vmName)}</span></h2>${pill}</div>${status}<ul class="runner-skill-list" role="list" aria-label="VM delete steps">${rows}</ul>${actions}</section>`;
}

export function runnerVmMarkup(
  vm: MemberVm,
  view: { busy: boolean; pools?: PoolList; denied?: string | null },
): string {
  if (vm.deleting) return memberVmDeleteMarkup(vm, { busy: view.busy, title: "Deleting VM" });
  const pool = vm.pool ? ` It is in exe.dev pool <b class="mono">${esc(vm.pool)}</b>.` : "";
  const move = view.pools
    ? memberVmMoveMarkup(vm, view.pools, { busy: view.busy, denied: view.denied ?? null })
    : "";
  return `<section class="runner-section" aria-labelledby="runner-vm-${esc(vm.id)}"><div class="between"><h2 id="runner-vm-${esc(vm.id)}">exe.dev VM <span class="mono">${esc(vm.vmName)}</span></h2>${deleteButton(vm, view.busy)}</div><p class="muted">Created with Create VM. Deleting it destroys the VM on exe.dev and removes this runner from Paws.${pool}</p>${move}</section>`;
}

export function memberVmsMarkup(vms: readonly MemberVm[], view: { busy: boolean }): string {
  if (vms.length === 0) return "";
  const rows = vms
    .filter((vm) => !vm.deleting)
    .map((vm) => {
      const [tone, label] =
        vm.failure !== null
          ? ["bad", "Setup failed"]
          : vm.step === "ready"
            ? ["ok", "Ready"]
            : ["running", "Setting up"];
      const owner = vm.ownerName ? `Created by ${vm.ownerName}` : "Created with Create VM";
      return `<li class="runner-skill" data-member-vm-other="${esc(vm.id)}"><span class="runner-skill-name"><b class="mono">${esc(vm.vmName)}</b><span class="muted">${esc(owner)}</span></span><span class="tag ${tone}">${esc(label)}</span><div class="runner-agent-actions">${deleteButton(vm, view.busy)}</div></li>`;
    })
    .join("");
  const list = rows
    ? `<section class="runner-section" aria-labelledby="member-vms-heading"><h2 id="member-vms-heading">Members' VMs</h2><p class="muted">VMs other members created with Create VM. As a workspace admin you can delete them.</p><ul class="runner-skill-list" role="list" aria-label="Members' VMs">${rows}</ul></section>`
    : "";
  const deleting = vms
    .filter((vm) => vm.deleting)
    .map((vm) =>
      memberVmDeleteMarkup(vm, {
        busy: view.busy,
        title: vm.ownerName ? `Deleting ${vm.ownerName}'s VM` : "Deleting VM",
      }),
    )
    .join("");
  return `${list}${deleting}`;
}

/** The member's VM: each step with its state and time, the stored error and Retry. */
export function memberVmMarkup(
  vm: MemberVm,
  view: { busy: boolean; runner: Pick<Runner, "id" | "name" | "status"> | null },
): string {
  if (vm.deleting) return memberVmDeleteMarkup(vm, { busy: view.busy, title: "Deleting your VM" });
  const removed = vm.step === "ready" && (view.runner === null || view.runner.status === "revoked");
  const ready = vm.step === "ready" && !removed;
  const rows = vm.steps
    .map((entry) => {
      const [tone, label] = VM_STATES[entry.state];
      const time =
        entry.elapsedMs === null
          ? ""
          : `<span class="muted" data-vm-elapsed>${esc(durationLabel(entry.elapsedMs))}</span>`;
      const error =
        entry.state === "failed"
          ? `<p class="runner-skill-error" role="alert">${esc(vm.failure ?? "The step failed without a reason.")}</p>`
          : "";
      return `<li class="runner-skill" data-vm-step="${esc(entry.step)}" data-vm-state="${esc(entry.state)}"><span class="runner-skill-name"><b>${esc(VM_STEPS[entry.step])}</b>${time}</span><span class="tag ${tone}">${esc(label)}</span>${error}</li>`;
    })
    .join("");
  const disabled = view.busy ? " disabled" : "";
  const retry =
    vm.failure !== null
      ? `<button class="btn primary" data-vm-retry data-focus="vm-retry"${disabled}>Retry</button>`
      : removed
        ? `<button class="btn primary" data-vm-create data-focus="vm-create"${disabled}>Enroll again</button>`
        : "";
  const status = removed
    ? "<p>The runner on this VM was removed. Enroll the VM again to add it as a new runner.</p>"
    : ready
      ? view.runner
        ? `<p>The runner is ready${view.runner.status === "paused" ? " (paused)" : ""} and owned by you. <a href="${esc(routeHref({ view: "runners", id: view.runner.id }))}" data-focus="vm-open">Open ${esc(view.runner.name)}</a> to sign in to coding agents${view.runner.status === "paused" ? ", then turn it on" : ""}.</p>`
        : "<p>The runner is ready and owned by you.</p>"
      : vm.failure === null
        ? '<p class="muted">Paws creates the VM, installs the runner and enrolls it for you. This takes a few minutes.</p>'
        : '<p class="muted">Retry resumes from the failed step.</p>';
  const pill = removed
    ? '<span class="tag warn">Removed</span>'
    : ready
      ? `<span class="tag ${view.runner?.status === "paused" ? "paused" : "ok"}">Ready${view.runner?.status === "paused" ? " (paused)" : ""}</span>`
      : vm.failure === null
        ? '<span class="tag running">Setting up</span>'
        : '<span class="tag bad">Failed</span>';
  return `<section class="runner-section" data-member-vm="${esc(vm.step)}" aria-labelledby="member-vm-heading"><div class="between"><h2 id="member-vm-heading" tabindex="-1" data-focus="vm-heading">Your VM <span class="mono">${esc(vm.vmName)}</span></h2>${pill}</div>${status}<ul class="runner-skill-list" role="list" aria-label="VM setup steps">${rows}</ul><div class="settings-actions">${retry}${deleteButton(vm, view.busy)}</div></section>`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The one command a member runs on a fresh Linux host: install the runner, write its config for
 * this Paws, stage the token in a root-owned mode 0600 file, enroll and start the daemon. The
 * token reaches the file through the shell's printf builtin, never through a process's argv.
 */
export function hostEnrollmentCommand(enrollment: HostEnrollment & { config: object }): string {
  const config = JSON.stringify({ ...enrollment.config, concurrency: 2 });
  return [
    "curl -fsSL https://get.paws.boo | sudo sh",
    `printf '%s\\n' ${shellQuote(enrollment.token)} | sudo install -o root -g root -m 0600 /dev/stdin /etc/paws-runner/enrollment-token`,
    `printf '%s\\n' ${shellQuote(config)} | sudo install -o root -g paws-runner -m 0640 /dev/stdin /etc/paws-runner/config.json`,
    `sudo /opt/paws-runner/bin/paws-runner runner enroll --config /etc/paws-runner/config.json --name ${shellQuote(enrollment.name)} --token-file /etc/paws-runner/enrollment-token`,
    "sudo rm -f /etc/paws-runner/enrollment-token",
    "sudo systemctl enable --now paws-runner.service",
  ].join(" && \\\n  ");
}

const AGENTS = ["claude", "codex", "grok"] as const;
const AGENT_LABELS: Record<string, string> = { claude: "Claude", codex: "Codex", grok: "Grok" };
const SIGN_IN: Record<AgentSignIn["status"], [string, string]> = {
  signed_in: ["ok", "Signed in"],
  signed_out: ["bad", "Signed out"],
  checking: ["running", "Checking"],
  usage_limit: ["warn", "Usage limit"],
  unknown: ["", "Not checked"],
};

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

const AGENT_NAMES: Record<string, string> = { claude: "Claude", codex: "Codex", grok: "Grok" };

/** The agent versions Paws offers: published on npm at least 48 hours ago, integrity unchanged. */
export function agentCatalogMarkup(
  entries: readonly AgentCatalogEntry[],
  now: number,
  update?: { manages: boolean; busy: boolean; behind: number },
): string {
  if (!entries.length) return "";
  const rows = entries
    .map((entry) => {
      const name = AGENT_NAMES[entry.agent] ?? entry.agent;
      const offered = entry.offered
        ? `<span class="mono">${esc(entry.offered)}</span>`
        : '<span class="muted">No version is eligible yet</span>';
      const refused = entry.refused
        .map(
          (item) =>
            `<p class="runner-skill-error" role="note"><b>Refused <span class="mono">${esc(item.version)}</span>.</b> ${esc(item.reason)}</p>`,
        )
        .join("");
      return `<li class="runner-skill" data-agent-catalog="${esc(entry.agent)}"><span class="runner-skill-name"><b>${esc(name)}</b>${offered}</span><span class="muted">Checked ${esc(updatedLabel(entry.checkedAt, now))}</span>${refused}</li>`;
    })
    .join("");
  const all =
    update?.manages && update.behind > 0
      ? `<button class="btn primary" data-agents-update-all data-focus="agents-update-all"${update.busy ? " disabled" : ""}>Update all runners</button>`
      : "";
  const behind = update?.behind
    ? `<p class="muted">${update.behind === 1 ? "1 coding agent on your runners is" : `${update.behind} coding agents on your runners are`} behind the newest eligible version.</p>`
    : "";
  return `<section class="runner-section" aria-labelledby="agent-catalog-heading"><div class="between"><h2 id="agent-catalog-heading">Coding agent versions</h2>${all}</div><p class="muted">Paws offers a version once it has been on npm for 2 days, is not deprecated or a prerelease, and its integrity has not changed.</p>${behind}<ul class="runner-skill-list" role="list" aria-label="Coding agent versions">${rows}</ul></section>`;
}

/** The newest eligible version of `agent` when the runner runs an older one and has not asked for it. */
export function codingAgentUpdate(
  entry: RunnerCodingAgent,
  catalog: readonly AgentCatalogEntry[],
): string | null {
  const offered = catalog.find((item) => item.agent === entry.agent)?.offered ?? null;
  if (offered === null || entry.current === null || offered === entry.current) return null;
  if ((compareVersions(offered, entry.current) ?? 1) < 0) return null;
  const pending = entry.pending;
  if (pending && pending.version === offered && pending.status !== "failed") return null;
  return offered;
}

export function listedRunners(runners: readonly Runner[]): Runner[] {
  return runners.filter((runner) => runner.status !== "revoked");
}

/** How many agents across these runners are behind the newest eligible version. */
export function codingAgentsBehind(
  runners: readonly Runner[],
  catalog: readonly AgentCatalogEntry[],
): number {
  return runners
    .filter((runner) => runner.status !== "revoked")
    .flatMap((runner) => runner.codingAgents ?? [])
    .filter((entry) => codingAgentUpdate(entry, catalog) !== null).length;
}

export function sessionsLabel(sessions: number | null): string {
  if (!sessions) return "Waiting for sessions to finish";
  return `Waiting for ${sessions} ${sessions === 1 ? "session" : "sessions"} to finish`;
}

/** Each coding agent on a runner card: its version, the newest eligible one, and an update in flight. */
export function runnerCodingAgentsMarkup(
  agents: readonly RunnerCodingAgent[],
  view: {
    runnerId: string;
    catalog: readonly AgentCatalogEntry[];
    manages: boolean;
    busy: boolean;
  },
): string {
  if (!agents.length)
    return '<p class="muted">This runner does not report its coding agent versions. Update the runner package to manage them here.</p>';
  const runner = esc(view.runnerId);
  const disabled = view.busy ? " disabled" : "";
  const rows = agents
    .map((entry) => {
      const name = AGENT_NAMES[entry.agent] ?? entry.agent;
      const offered = view.catalog.find((item) => item.agent === entry.agent)?.offered ?? null;
      const update = codingAgentUpdate(entry, view.catalog);
      const pending = entry.pending;
      const current = entry.current ?? "not reported";
      let tag: [string, string];
      let detail = "";
      let error = "";
      if (pending?.status === "failed") {
        tag = ["bad", "Install failed"];
        error = `<p class="runner-skill-error" role="note">${esc(pending.error ?? "The runner did not report why.")}</p>`;
      } else if (pending?.status === "waiting") {
        tag = ["running", sessionsLabel(pending.sessions)];
        detail = `Switches to ${pending.version} when they end. They keep ${current}.`;
      } else if (pending) {
        tag = ["running", "Installing"];
        detail =
          pending.status === "requested"
            ? `Installing ${pending.version} at the runner's next heartbeat.`
            : `Installing ${pending.version}. Sessions use ${current} until it is in place.`;
      } else if (update) tag = ["warn", "Update available"];
      else tag = ["ok", "Up to date"];
      const newest =
        offered === null
          ? '<span class="muted">No eligible version yet</span>'
          : offered === entry.current
            ? ""
            : `<span class="muted">Newest eligible <span class="mono">${esc(offered)}</span></span>`;
      const actions =
        view.manages && update
          ? `<button class="btn" data-agent-update="${esc(entry.agent)}" data-runner="${runner}" data-version="${esc(update)}" data-focus="agent-update:${runner}:${esc(entry.agent)}"${disabled}>Update to ${esc(update)}</button>`
          : "";
      return `<li class="runner-skill" data-coding-agent="${esc(entry.agent)}"><span class="runner-skill-name"><b>${esc(name)}</b><span class="mono">${esc(current)}</span>${newest}</span><span class="tag ${tag[0]}">${esc(tag[1])}</span>${detail ? `<p class="muted">${esc(detail)}</p>` : ""}${error}${actions ? `<div class="runner-agent-actions">${actions}</div>` : ""}</li>`;
    })
    .join("");
  return `<ul class="runner-skill-list" role="list" aria-label="Coding agent versions on this runner">${rows}</ul>`;
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
      ? `<span class="tag ${runner.status === "paused" ? "paused" : runnerDrained(runner) ? "ok" : "warn"}">${runner.status === "paused" ? "Paused" : runnerDrained(runner) ? "Drained" : "Draining"}</span>`
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
    runner.status !== "revoked" && runner.skills?.some((skill) => skill.state === "failed")
      ? '<span class="tag bad">Skill install failed</span>'
      : "",
  ].join("");
  const os = [runner.os?.id, runner.os?.version].filter(Boolean).join(" ");
  const meta = [
    runner.metrics
      ? `Seen ${seenLabel(runner.metrics.reportedAt, view.now).replace(/^Just now$/, "just now")}`
      : "Never reported",
    runner.ownerName ? `Owned by ${runner.ownerName}` : "",
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
      const work = entry.identifier
        ? `${issueLink(entry.identifier, entry.title ?? "")}<p class="muted">${purpose}</p>`
        : purpose;
      const agent = entry.agent ? (AGENT_LABELS[entry.agent] ?? entry.agent) : "None";
      const outcome =
        entry.outcome === null
          ? '<span class="tag running">Running</span>'
          : `<span class="tag outcome ${entry.outcome === "success" ? "ok" : entry.outcome === "cancelled" ? "warn" : "bad"}">${esc(entry.outcome[0]!.toUpperCase() + entry.outcome.slice(1).replaceAll("_", " "))}</span>`;
      const duration =
        entry.endedAt === null ? "Running" : durationLabel(entry.endedAt - entry.startedAt);
      return `<tr><td><span title="${esc(new Date(entry.startedAt).toLocaleString())}">${esc(new Date(entry.startedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }))}</span></td><td>${work}</td><td class="hide-phone">${esc(agent)}${entry.resolvedModel ? `<p class="muted">${esc(entry.modelLabel ?? entry.resolvedModel)}</p>` : ""}</td><td class="hide-phone">${esc(duration)}</td><td>${outcome}</td></tr>`;
    })
    .join("");
  return `<table class="runner-history"><thead><tr><th>Started</th><th>Issue</th><th class="hide-phone">Agent</th><th class="hide-phone">Duration</th><th>Outcome</th></tr></thead><tbody>${rows}</tbody></table>`;
}

const SKILL_STATES: Record<RunnerSkill["state"], [string, string]> = {
  up_to_date: ["ok", "Up to date"],
  installing: ["running", "Installing"],
  out_of_date: ["warn", "Out of date"],
  failed: ["bad", "Install failed"],
};

export function waitingLabel(tasks: number, runner: string): string {
  return `Waiting for ${tasks} running ${tasks === 1 ? "item" : "items"} on ${runner}`;
}

export function runnerSkillsMarkup(skills: readonly RunnerSkill[], runner: string): string {
  if (!skills.length)
    return '<p class="muted">No skills registered. Admins add them in Settings → Agents.</p>';
  const rows = skills
    .map((skill) => {
      const [tone, state] = SKILL_STATES[skill.state] ?? SKILL_STATES.installing;
      const label = skill.waiting ? "Waiting" : state;
      const pinned = skillVersionLabel(skill.version);
      const has =
        skill.installedVersion === null ? null : skillVersionLabel(skill.installedVersion);
      const detail = skill.waiting
        ? `${waitingLabel(skill.waiting, runner)}.${has && has !== pinned ? ` Has ${has} until they end.` : ""}`
        : skill.state === "out_of_date" && has
          ? `Has ${has}. Paws pins ${pinned}.`
          : skill.state === "installing" && has && has !== pinned
            ? `Has ${has} until no issue is using it.`
            : skill.state === "installing" && skill.reportedAt === null
              ? "Not reported by this runner yet."
              : "";
      const error =
        skill.state === "failed"
          ? `<p class="runner-skill-error" role="note">${esc(skill.error ?? "The runner did not report why.")}</p>`
          : "";
      return `<li class="runner-skill" data-skill-state="${esc(skill.state)}"><span class="runner-skill-name"><b>${esc(skill.name)}</b><span class="mono" title="${esc(skill.version)}">${esc(pinned)}</span></span><span class="tag ${tone}">${esc(label)}</span>${detail ? `<p class="muted">${esc(detail)}</p>` : ""}${error}</li>`;
    })
    .join("");
  return `<ul class="runner-skill-list" role="list" aria-label="Installed skills">${rows}</ul>`;
}

export function runnerRuntimesMarkup(runtimes: readonly RunnerRuntime[]): string {
  if (!runtimes.length)
    return '<p class="muted">No runtimes installed yet. The runner installs a repository\'s mise runtimes when an item starts.</p>';
  const rows = runtimes
    .map((runtime) => {
      const failed = runtime.status === "failed";
      const error = failed
        ? `<p class="runner-skill-error" role="note">${esc(runtime.error ?? "The runner did not report why.")}</p>`
        : "";
      return `<li class="runner-skill" data-runtime-status="${failed ? "failed" : "installed"}"><span class="runner-skill-name"><b>${esc(runtime.tool)}</b><span class="mono">${esc(runtime.version)}</span></span><span class="tag ${failed ? "bad" : "ok"}">${failed ? "Install failed" : "Installed"}</span>${error}</li>`;
    })
    .join("");
  return `<ul class="runner-skill-list" role="list" aria-label="Installed runtimes">${rows}</ul>`;
}

const PHASES: Record<RunningSession["phase"], [string, string]> = {
  working: ["running", "Working"],
  closeout: ["verifying", "Closeout"],
  fixing: ["warn", "Fixing"],
  merging: ["now", "Merging"],
};

function issueLink(identifier: string, title: string): string {
  return `<a class="work-title" href="${esc(routeHref({ view: "issues", id: identifier }))}"><span class="lin-id">${esc(identifier)}</span> ${esc(title)}</a>`;
}

function elapsedLabel(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
}

/** How a session's move stands, and Move to another runner for admins. */
function sessionMoveMarkup(
  session: RunningSession,
  move: { runnerId: string; busy: boolean } | undefined,
): string {
  const runId = esc(session.runId);
  const status = session.move?.status;
  const note =
    status === "moving" || status === "waiting"
      ? `<p class="slot-note" role="status"><b>Moving to another runner</b>${status === "waiting" && session.move?.reason ? ` · ${esc(session.move.reason)}` : ""}</p>`
      : status === "stayed"
        ? `<p class="runner-skill-error" role="note">Not moved. ${esc(session.move?.reason ?? "The runner kept the session.")}</p>`
        : "";
  const button =
    move && session.movable && status !== "moving" && status !== "waiting"
      ? `<button class="btn" data-session-move="${runId}" data-runner="${esc(move.runnerId)}" data-focus="move:${runId}"${move.busy ? " disabled" : ""}>Move to another runner</button>`
      : "";
  return note || button ? `<div class="slot-move">${note}${button}</div>` : "";
}

/**
 * One row per busy slot with the session it holds, then one row for the free slots. With
 * `move`, a running session's row offers Move to another runner.
 */
export function runnerRunningMarkup(
  sessions: readonly RunningSession[],
  now: number,
  slots?: { used: number; total: number },
  move?: { runnerId: string; busy: boolean },
): string {
  const total = Math.max(slots?.total ?? 0, sessions.length);
  const free = total - Math.max(slots?.used ?? 0, sessions.length);
  if (!sessions.length && !slots?.used && free <= 0) return '<p class="muted">Nothing running</p>';
  const full = total > 0 && free <= 0;
  const rows = sessions
    .map((session) => {
      const [tone, phase] = PHASES[session.phase] ?? PHASES.working;
      return `<li class="slot-row" data-running-run="${esc(session.runId)}"><span class="slot-mark used${full ? " high" : ""}" aria-hidden="true"></span>${issueLink(session.identifier, session.title)}<span class="slot-facts">${statePill(tone, phase)}<span class="muted" title="Started ${esc(new Date(session.startedAt).toLocaleString())}">${esc(elapsedLabel(now - session.startedAt))}</span></span>${sessionMoveMarkup(session, move)}</li>`;
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
  return `<ul class="slot-list" role="list" aria-label="Running issues">${rows}${busy}${idle}</ul>`;
}

/** A draining runner nothing runs on any more, not even a check or helper: safe to remove. */
export function runnerDrained(
  runner: Pick<Runner, "status" | "running" | "slots" | "idle">,
): boolean {
  return (
    runner.status === "draining" &&
    runner.idle !== false &&
    !runner.running?.length &&
    (runner.slots?.used ?? 0) === 0
  );
}

function sessionCount(count: number): string {
  return `${count} ${count === 1 ? "session" : "sessions"}`;
}

/**
 * How a draining runner's work is moving off it: Drained once nothing runs there, otherwise
 * how many sessions move and wait, with Move running work for admins.
 */
export function runnerDrainMarkup(
  runner: Pick<Runner, "id" | "status" | "running" | "slots" | "idle">,
  state: { manages: boolean; busy: boolean },
): string {
  if (runner.status !== "draining") return "";
  if (runnerDrained(runner))
    return '<div class="runner-drain"><div class="runner-drain-state" role="status"><span class="tag ok">Drained</span><p>Nothing runs here any more. It is safe to remove this runner.</p></div></div>';
  const sessions = runner.running ?? [];
  const moving = sessions.filter((session) => session.move?.status === "moving").length;
  const waiting = sessions.filter((session) => session.move?.status === "waiting").length;
  const running = Math.max(sessions.length, runner.slots?.used ?? 0);
  const notes = [
    moving ? `<p><b>Moving ${sessionCount(moving)}</b></p>` : "",
    waiting
      ? `<p><b>${sessionCount(waiting)} waiting for another runner</b>. Each row says why.</p>`
      : "",
    moving || waiting
      ? ""
      : running
        ? `<p>${sessionCount(running)} still ${running === 1 ? "runs" : "run"} here. Move them, or wait for them to finish.</p>`
        : "<p>Finishing its last commands. It shows Drained once they end.</p>",
  ].join("");
  const movable = sessions.some(
    (session) =>
      session.movable && session.move?.status !== "moving" && session.move?.status !== "waiting",
  );
  const id = esc(runner.id);
  const button =
    state.manages && movable
      ? `<button class="btn" data-runner-move-all="${id}" data-focus="move-all:${id}"${state.busy ? " disabled" : ""}>Move running work</button>`
      : "";
  return `<div class="runner-drain"><div class="runner-drain-state" role="status">${notes}</div>${button}</div>`;
}

/** Processes that outlived their run, busiest first, so someone can stop them. */
export function runnerStrayMarkup(strays: readonly StrayProcess[]): string {
  const rows = strays
    .map((stray) => {
      const busy = stray.cpuPercent >= 50;
      const cpu = `${Math.round(stray.cpuPercent)}% CPU`;
      return `<li class="slot-row" data-stray-pid="${stray.pid}"><span class="slot-mark used${busy ? " high" : ""}" aria-hidden="true"></span><span class="lin-id">${esc(stray.name)}</span><span class="work-title">PID ${stray.pid}</span><span class="slot-facts">${busy ? `<span class="gauge-value high">${esc(cpu)}<span class="sr-only">, high</span></span>` : `<span class="gauge-value">${esc(cpu)}</span>`}<span class="muted">Running ${esc(elapsedLabel(stray.ageSeconds * 1000))}</span></span></li>`;
    })
    .join("");
  return `<p class="muted">Still running as the runner user after their work ended.</p><ul class="slot-list" role="list" aria-label="Stray processes">${rows}</ul>`;
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

function firstActivation(runner: Runner): boolean {
  return runner.status === "paused" && runner.hasRunWork === false;
}

function pauseMarkup(runner: Runner, state: { manages: boolean; busy: boolean }): string {
  if (!state.manages || runner.status === "revoked") return "";
  const id = esc(runner.id);
  const [next, label] =
    runner.status === "active"
      ? ["paused", "Pause"]
      : ["active", firstActivation(runner) ? "Turn on" : "Resume"];
  return `<button class="btn" data-runner-status="${next}" data-runner="${id}" data-focus="status:${id}:toggle"${state.busy ? " disabled" : ""}>${label}</button>`;
}

/** The concurrency field for admins, or the values for everyone else. */
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
      ? "Set in the runner config. Update the runner to change it here."
      : `Runner limit ${ceiling}. Runner applied ${applied}.`;
  if (!state.manages || ceiling === null)
    return `${esc(String(value))} <span class="muted">${esc(reported)}</span>`;
  const disabled = state.busy ? " disabled" : "";
  return `<form class="row" data-runner-concurrency="${id}"><input class="concurrency-input" name="concurrency" inputmode="numeric" pattern="[0-9]*" maxlength="2" size="3" required aria-label="Slots, from 1 to ${ceiling}" value="${esc(state.draft ?? String(value))}" data-focus="concurrency:${id}"${disabled}><button class="btn" type="submit" data-focus="concurrency:${id}:save"${disabled}>Save</button><span class="muted">${esc(reported)}</span></form>`;
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
    return '<section class="runner-host" aria-label="Runner metrics"><p class="muted">This runner has not reported runner metrics yet.</p></section>';
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
  return `<section class="runner-host" aria-label="Runner metrics"${stale ? ' data-stale=""' : ""}><dl class="runner-gauges${stale ? " stale" : ""}">${gauges.map(gaugeMarkup).join("")}</dl></section>`;
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
  const limits =
    entry.status === "signed_out"
      ? []
      : (entry.limits ?? []).filter((limit) => !limit.resetsAt || limit.resetsAt > now);
  const gauges = limits
    .map((limit) =>
      gaugeMarkup({
        label: limit.window,
        value: `${Math.round(limit.usedPercent)}% used`,
        fill: limit.usedPercent,
        high: limit.usedPercent >= 90,
        ...(limit.resetsAt ? { detail: resetLabel(limit.resetsAt, now) } : {}),
      }),
    )
    .join("");
  const observed = entry.limitsAt
    ? `<p class="muted">As of ${esc(updatedLabel(entry.limitsAt, now))}</p>`
    : "";
  const usage = limits.length
    ? `<div class="agent-usage"><dl class="agent-limits">${gauges}</dl>${observed}</div>`
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
    runner.status === "paused"
      ? "Paused"
      : runnerDrained(runner)
        ? "Drained"
        : runner.status === "draining"
          ? "Draining"
          : "",
    stale ? "Stale" : "",
    updateAvailable(runner, view.serverVersion) ? "Update available" : "",
  ].filter(Boolean);
  return `<p class="runner-status"><span class="tag ${tone}">${esc(state)}</span>${notes.map((note) => `<span>${esc(note)}</span>`).join("")}</p>`;
}

function runtimeCountLabel(runtimes: readonly RunnerRuntime[]): string {
  const failed = runtimes.filter((runtime) => runtime.status === "failed").length;
  const installed = runtimes.length - failed;
  return [`${installed} installed`, failed ? `${failed} failed` : ""].filter(Boolean).join(", ");
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
    /** The agent catalog, for the newest eligible versions. */
    catalog?: readonly AgentCatalogEntry[];
  },
): string {
  const id = esc(runner.id);
  const metrics = runner.metrics;
  const revoked = runner.status === "revoked";
  const manages = view.role === "admin";
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
    !revoked;
  const editable = owns && !view.busy ? "" : " disabled";
  const signIns = runner.agents?.length
    ? runner.agents
    : AGENTS.map((agent): AgentSignIn => ({ agent, status: "unknown", checkedAt: null }));
  const signIn = !owns
    ? ""
    : `<button class="btn" data-runner-signin="${id}" data-focus="signin:${id}">Sign in to agents</button>`;
  const slots = runner.slots;
  const capacity = slots
    ? `<span class="gauge-value${slots.total > 0 && slots.used >= slots.total ? " high" : ""}">${esc(`${slots.used} of ${slots.total} slots in use`)}</span>`
    : "";
  const head = `<div class="runner-head"><div class="runner-title"><h2 id="runner-${id}-name">${esc(runner.name)}</h2>${statusLine(runner, view)}<p class="runner-meta" title="${esc(metrics ? new Date(metrics.reportedAt).toLocaleString() : "")}">${meta}</p></div>${pauseMarkup(runner, { manages: manages || owns, busy: view.busy })}</div>`;
  const block = (key: string, title: string, aside: string, body: string) =>
    `<section class="runner-block" aria-labelledby="runner-${id}-${key}"><div class="runner-block-head"><h3 id="runner-${id}-${key}">${title}</h3>${aside}</div>${body}</section>`;
  const card = `<section class="runner-section" data-runner-card="${id}" aria-labelledby="runner-${id}-name">${head}${firstActivation(runner) ? "<p>Sign in the coding agents this runner should use, then turn it on.</p>" : ""}${
    revoked
      ? ""
      : block(
          "slots",
          "Running issues",
          capacity,
          runnerDrainMarkup(runner, { manages, busy: view.busy }) +
            runnerRunningMarkup(
              runner.running ?? [],
              view.now,
              slots,
              manages ? { runnerId: runner.id, busy: view.busy } : undefined,
            ),
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
  }${
    revoked || runner.skills === undefined
      ? ""
      : block(
          "skills",
          "Skills",
          runner.skills.length
            ? `<span class="muted">${runner.skills.filter((skill) => skill.state === "up_to_date").length} of ${runner.skills.length} up to date</span>`
            : "",
          runnerSkillsMarkup(runner.skills, runner.name),
        )
  }${
    revoked || runner.codingAgents === undefined
      ? ""
      : block(
          "coding-agents",
          "Coding agents",
          "",
          runnerCodingAgentsMarkup(runner.codingAgents, {
            runnerId: runner.id,
            catalog: view.catalog ?? [],
            manages,
            busy: view.busy,
          }),
        )
  }${
    revoked || runner.runtimes === undefined
      ? ""
      : block(
          "runtimes",
          "Runtimes",
          runner.runtimes.length
            ? `<span class="muted">${runtimeCountLabel(runner.runtimes)}</span>`
            : "",
          runnerRuntimesMarkup(runner.runtimes),
        )
  }${block("host", "Runner", "", runnerMetricsMarkup(metrics, view.now))}${
    metrics?.strayProcesses?.length
      ? block("strays", "Stray processes", "", runnerStrayMarkup(metrics.strayProcesses))
      : ""
  }</section>`;
  const concurrency = runnerConcurrencyMarkup(runner, {
    manages,
    busy: view.busy,
    ...(view.concurrencyDraft === undefined ? {} : { draft: view.concurrencyDraft }),
  });
  const sharing =
    view.policy === null || revoked
      ? ""
      : `<label class="runner-consent"><input type="checkbox" data-runner-sharing="${id}" data-focus="sharing:${id}"${view.policy.sharing ? " checked" : ""}${editable}><span>Share this runner with members of the same Linear project</span></label>${owns ? "" : '<p class="muted">The runner owner controls its sharing settings.</p>'}`;
  const copy = `<button class="btn" data-runner-copy="${id}" data-focus="copy:${id}" title="${id}" aria-label="Copy runner ID ${id}">Copy ID</button>`;
  const settings = [
    concurrency ? `<div class="runner-setting"><h3>Slots</h3><div>${concurrency}</div></div>` : "",
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
  let agentCatalog: AgentCatalogEntry[] = [];
  let policies = new Map<string, HostPolicy>();
  let session: Session | null = null;
  let setupRequired = false;
  let workspaceReady = false;
  let usage: Usage[] = [];
  let usageRunner: string | null = null;
  let addingHost = false;
  let hostName = "";
  let enrollment: HostEnrollment | null = null;
  let memberVm: MemberVmState = { available: false };
  let pools: PoolList = { state: "loading" };
  let poolChoice = "";
  let adoptDenied: string | null = null;
  let confirmingDelete: string | null = null;
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
    return session !== null && session.role === "admin";
  }
  function reset() {
    session = null;
    loaded = false;
    runners = [];
    policies = new Map();
    serverVersion = null;
    agentCatalog = [];
    usage = [];
    usageRunner = null;
    addingHost = false;
    enrollment = null;
    memberVm = { available: false };
    pools = { state: "loading" };
    poolChoice = "";
    adoptDenied = null;
    confirmingDelete = null;
  }
  function deletableVms(): MemberVm[] {
    const state = memberVm;
    if (!state.available) return [];
    const own = state.vm ? [state.vm] : [];
    return [...own, ...(state.vms ?? []).filter((entry) => entry.id !== state.vm?.id)];
  }
  function deleteDialog(): string {
    const vm = deletableVms().find((entry) => entry.id === confirmingDelete);
    return vm && !vm.deleting ? memberVmDeleteDialogMarkup(vm, { busy }) : "";
  }
  /** Any active member may add a host, and owns it. */
  function addsHosts() {
    return session !== null;
  }
  async function api<T>(path: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
    if (!available) throw new Error("Connect to your Paws dashboard to see runners.");
    const response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
      headers:
        body === undefined
          ? {}
          : {
              "content-type": "application/json",
              "x-paws-csrf": readCsrfToken(document),
            },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = (await response.json().catch((caughtError1) => {
      journalCaught(caughtError1, "runners.api.json", null);
      return null;
    })) as { error?: string } | null;
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
        agentVersions?: AgentCatalogEntry[];
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
                (caughtError1) => {
                  journalCaught(caughtError1, "runners.load.api", null);
                  return null;
                },
              ),
            ),
        ),
      ]);
      if (current !== generation) return;
      // A failed refresh keeps the last state.
      const vm: MemberVmState = await api<MemberVmState>("/api/runners/vm").catch(
        (caughtError2) => {
          journalCaught(caughtError2, "runners.load.api", null);
          return memberVm;
        },
      );
      if (current !== generation) return;
      memberVm = vm;
      // exe.dev's pool list is read once per page, for Create VM and Move to pool.
      if (vm.available && pools.state === "loading")
        pools = await api<{ available: boolean; pools?: ExeDevPool[] }>(
          "/api/runners/vm/pools",
        ).then(
          (answer) => ({ state: "listed", pools: answer.pools ?? [] }),
          (caughtError3) => {
            journalCaught(caughtError3, "runners.load.pools", null);
            return {
              state: "failed",
              error:
                caughtError3 instanceof Error ? caughtError3.message : "exe.dev did not answer.",
            };
          },
        );
      if (current !== generation) return;
      runners = listedRunners(list.runners);
      loaded = true;
      serverVersion = list.serverVersion ?? null;
      agentCatalog = list.agentVersions ?? [];
      policies = new Map(hosts.filter((entry) => entry !== null));
      session = identity;
      usage = activity.usage;
      usageRunner = target;
      stale = "";
      if (!addsHosts()) {
        addingHost = false;
        enrollment = null;
      }
    } catch (caught) {
      journalCaught(caught, "runners.load.api", null);
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
        addingHost = false;
        enrollment = null;
        memberVm = { available: false };
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
    if (administrator ? !manages() : session === null) {
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
      journalCaught(caught, "runners.change.action", null);
      error = caught instanceof Error ? caught.message : "The runner change failed.";
    } finally {
      busy = false;
      paint();
    }
  }
  function listView(now: number, disabled: string, status: string): string {
    const rows = runners.map((runner) => runnerRowMarkup(runner, { now, serverVersion })).join("");
    const alert = error ? `<p role="alert" class="err">${esc(error)}</p>` : "";
    const adding = addsHosts() && addingHost;
    const expired = enrollment !== null && enrollment.expiresAt <= now;
    const command =
      enrollment?.config && !expired
        ? `<p>Run this on the Linux runner. It installs the runner, writes its config for this Paws and enrolls with a single-use token. The runner appears here, owned by you.</p><pre class="mono" id="runner-enroll-command">${esc(hostEnrollmentCommand({ ...enrollment, config: enrollment.config }))}</pre><div class="between"><p class="muted">The token expires at ${esc(new Date(enrollment.expiresAt).toLocaleTimeString())} and works once.</p><button class="btn" data-runner-enroll-copy data-focus="enroll-copy">Copy command</button></div>`
        : enrollment && !expired
          ? '<p role="alert" class="err">Paws has no public HTTPS address for runners. Set PAWS_PUBLIC_URL and restart Paws.</p>'
          : expired
            ? '<p class="muted">The token expired. Create a new command.</p>'
            : "";
    const dialog = adding
      ? `<dialog id="runner-add-dialog" aria-labelledby="runner-add-heading"><div class="dialog-body"><div class="between"><h2 id="runner-add-heading">Add a runner</h2><button class="btn" data-runner-add-close data-focus="add-close">Close</button></div>${alert}<form id="runner-enrollment"><label class="field"><span>Runner name</span><input name="host-name" data-focus="host-name" required maxlength="80" autocomplete="off" spellcheck="false" value="${esc(hostName)}"${disabled}></label><button class="btn primary" type="submit" data-focus="enroll"${disabled}>${enrollment ? "Create a new command" : "Create command"}</button></form>${command}</div></dialog>`
      : "";
    const empty = addsHosts()
      ? "<p>No runners are enrolled. Select <b>Add a runner</b> to connect a Linux runner.</p>"
      : "<p>No runners are enrolled. A workspace member adds a Linux runner with <b>Add a runner</b>.</p>";
    const vm = addsHosts() && memberVm.available ? memberVm.vm : null;
    const createVmSize =
      addsHosts() && memberVm.available && memberVm.vm === null
        ? memberVmSizeMarkup(memberVm.size)
        : "";
    const createVmPool =
      createVmSize && memberVm.available
        ? memberVmPoolMarkup(memberVm.size?.pool, pools, { choice: poolChoice, busy })
        : "";
    const createVm =
      addsHosts() && memberVm.available && memberVm.vm === null
        ? `<button class="btn" data-vm-create data-focus="vm-create"${createVmSize ? ' aria-describedby="vm-create-size"' : ""}${disabled}>Create VM</button>`
        : "";
    const actions = addsHosts()
      ? `<div class="settings-actions">${createVm}<button class="btn primary" data-runner-add aria-haspopup="dialog" data-focus="add">Add a runner</button></div>`
      : "";
    const vmSection = `${
      vm
        ? memberVmMarkup(vm, {
            busy,
            runner: runners.find((entry) => entry.id === vm.runnerId) ?? null,
          })
        : ""
    }${
      manages()
        ? memberVmsMarkup(
            deletableVms().filter((entry) => entry.id !== vm?.id),
            { busy },
          )
        : ""
    }`;
    return `<h1 class="sr-only">Runners</h1><div class="between"><p class="sub">The Linux runners that execute work delegated in Linear. Select a runner for its details and execution history.</p>${actions}</div>${adding ? "" : alert}${status}${createVmSize}${createVmPool}${vmSection}${runners.length ? `<ul class="runner-rows" role="list" aria-label="Runners">${rows}</ul>` : ""}${!busy && !runners.length && !error ? empty : ""}${agentCatalogMarkup(agentCatalog, now, { manages: manages(), busy, behind: codingAgentsBehind(runners, agentCatalog) })}${dialog}${deleteDialog()}`;
  }
  function detailView(id: string, now: number, notices: string): string {
    const list = routeHref({ view: "runners", id: null });
    const back = `<nav class="crumbs" aria-label="Breadcrumb"><a href="${list}" data-focus="back">All runners</a></nav>`;
    const runner = runners.find((entry) => entry.id === id);
    if (!runner)
      return `<h1 class="sr-only">Runners</h1>${back}${notices}${loaded ? `<div class="empty">This runner is not enrolled with your workspace. <a href="${list}">Choose another runner</a>.</div>` : ""}`;
    const runnerVm = deletableVms().find((entry) => entry.runnerId === runner.id);
    return `<h1 class="sr-only">Runners</h1>${back}${notices}${runnerDetailMarkup(runner, {
      now,
      serverVersion,
      policy: policies.get(runner.id) ?? null,
      userId: session?.userId ?? null,
      role: session?.role ?? null,
      busy,
      catalog: agentCatalog,
      ...(concurrencyDrafts.has(runner.id)
        ? { concurrencyDraft: concurrencyDrafts.get(runner.id)! }
        : {}),
    })}${runnerVm ? runnerVmMarkup(runnerVm, { busy, pools, denied: adoptDenied }) : ""}<section class="runner-section" aria-labelledby="runner-history-heading"><h2 id="runner-history-heading">Execution history</h2>${usageRunner === id ? runnerHistoryMarkup(usage) : '<p class="muted">Loading execution history…</p>'}</section>${deleteDialog()}`;
  }
  function markup(open: ReadonlySet<string>): string {
    if (setupRequired)
      return `<h1 class="sr-only">Runners</h1><p class="sub">Connect a Linux runner to execute work delegated in Linear.</p><section class="runner-section" aria-labelledby="runner-setup-heading"><h2 id="runner-setup-heading">Set up remote runners</h2><p>Enable secure runner access on your Paws server to enroll a runner.</p><ol>${workspaceReady ? "" : '<li>Configure workspace sign-in over HTTPS. <a href="https://github.com/pmdroid/paws-app/blob/main/docs/workspace-access.md" target="_blank" rel="noopener noreferrer">Open the workspace setup guide</a>.</li>'}<li>Initialize the runner identity once on the Paws server: <code>bun run paws runner-authority init</code>.</li><li>Enable the runner listener with <code>PAWS_RUNNER_HOST</code>, then restart Paws with your HTTPS workspace configuration.</li></ol><p>Then select <b>Add a runner</b> and run its command on the Linux runner.</p><button class="btn" data-runners-setup data-focus="setup"${busy ? " disabled" : ""}>${busy ? "Checking setup…" : "Check setup"}</button>${error ? `<p role="alert" class="err">${esc(error)}</p>` : ""}</section>`;
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
      feedback = "Runner settings saved.";
    }, false);
  }
  function bind() {
    root!.querySelector("[data-runners-setup]")?.addEventListener("click", () => void load());
    for (const box of root!.querySelectorAll<HTMLInputElement>("input[data-runner-sharing]"))
      box.addEventListener("change", () =>
        savePolicy(box.dataset.runnerSharing!, { sharing: box.checked }),
      );
    root!
      .querySelector<HTMLSelectElement>("[data-vm-pool]")
      ?.addEventListener("change", (event) => {
        poolChoice = (event.target as HTMLSelectElement).value;
      });
    for (const form of root!.querySelectorAll<HTMLFormElement>("form[data-vm-move]"))
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const id = form.dataset.vmMove!;
        const pool = form.querySelector<HTMLSelectElement>("select")!.value;
        void change(async () => {
          try {
            // exe.dev's /exec answers within 30 s, so wait a little longer than that.
            memberVm = await api<MemberVmState>("/api/runners/vm/pool", { id, pool }, 40_000);
            feedback = `exe.dev moved the VM to pool ${pool}.`;
          } catch (caught) {
            // exe.dev refused the token: leave the action out and say why in exe.dev's words.
            if (!(caught instanceof Error && "status" in caught && caught.status === 403))
              throw caught;
            journalCaught(caught, "runners.move.api", null);
            adoptDenied = caught.message;
          }
        }, false);
      });
    root!.querySelector("[data-vm-create]")?.addEventListener("click", () => {
      void change(async () => {
        memberVm = await api<MemberVmState>(
          "/api/runners/vm",
          poolChoice ? { pool: poolChoice } : {},
        );
        // The VM section reports progress itself, so focus moves there instead of a notice.
        refocus("vm-heading");
      }, false);
    });
    root!.querySelector("[data-vm-retry]")?.addEventListener("click", () => {
      void change(async () => {
        memberVm = await api<MemberVmState>("/api/runners/vm/retry", {});
        refocus("vm-heading");
      }, false);
    });
    for (const button of root!.querySelectorAll<HTMLElement>("[data-vm-delete]"))
      button.addEventListener("click", () => {
        confirmingDelete = button.dataset.vmDelete!;
        refocus("vm-delete-cancel");
        paint();
      });
    const removing = root!.querySelector<HTMLDialogElement>("#vm-delete-dialog");
    if (removing) {
      removing.showModal();
      removing.addEventListener("close", () => {
        if (!removing.isConnected || confirmingDelete === null) return;
        const id = confirmingDelete;
        confirmingDelete = null;
        refocus(`vm-delete:${id}`);
        paint();
      });
      removing.addEventListener("click", (event) => {
        if (event.target === removing) removing.close();
      });
      removing
        .querySelector("[data-vm-delete-cancel]")
        ?.addEventListener("click", () => removing.close());
      const confirm = removing.querySelector<HTMLElement>("[data-vm-delete-confirm]");
      confirm?.addEventListener("click", () => {
        const id = confirm.dataset.vmDeleteConfirm!;
        confirmingDelete = null;
        void change(async () => {
          memberVm = await api<MemberVmState>("/api/runners/vm/delete", { id });
          refocus(`vm-delete-progress:${id}`);
        }, false);
      });
    }
    for (const [attribute, force] of [
      ["vmDeleteRetry", false],
      ["vmDeleteForce", true],
    ] as const)
      for (const button of root!.querySelectorAll<HTMLElement>(
        `[data-${attribute === "vmDeleteRetry" ? "vm-delete-retry" : "vm-delete-force"}]`,
      ))
        button.addEventListener("click", () => {
          const id = button.dataset[attribute]!;
          void change(async () => {
            memberVm = await api<MemberVmState>("/api/runners/vm/delete", {
              id,
              ...(force ? { force: true } : {}),
            });
            refocus(`vm-delete-progress:${id}`);
          }, false);
        });
    root!.querySelector<HTMLElement>("[data-runner-add]")?.addEventListener("click", () => {
      addingHost = true;
      enrollment = null;
      refocus("host-name");
      paint();
    });
    const dialog = root!.querySelector<HTMLDialogElement>("#runner-add-dialog");
    if (dialog) {
      dialog.showModal();
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      dialog.addEventListener("close", () => {
        if (!dialog.isConnected || !addingHost) return;
        addingHost = false;
        enrollment = null;
        error = "";
        refocus("add");
        paint();
      });
      dialog.addEventListener("click", (event) => {
        if (event.target === dialog) dialog.close();
      });
      dialog
        .querySelector("[data-runner-add-close]")
        ?.addEventListener("click", () => dialog.close());
    }
    root!
      .querySelector<HTMLInputElement>('input[name="host-name"]')
      ?.addEventListener("input", (event) => {
        hostName = (event.target as HTMLInputElement).value;
      });
    root!.querySelector("#runner-enrollment")?.addEventListener("submit", (event) => {
      event.preventDefault();
      void change(async () => {
        enrollment = await api<HostEnrollment>("/api/runners/enrollments", {
          name: hostName.trim(),
        });
        refocus("enroll-copy");
      }, false);
    });
    root!.querySelector("[data-runner-enroll-copy]")?.addEventListener("click", () => {
      if (!enrollment?.config) return;
      const value = hostEnrollmentCommand({ ...enrollment, config: enrollment.config });
      void Promise.resolve()
        .then(() => navigator.clipboard.writeText(value))
        .then(
          () => {
            error = "";
            feedback = "Command copied. Run it on the runner.";
          },
          (caughtError2) => {
            journalCaught(caughtError2, "runners.bind.then", null);
            error = "The command could not be copied. Select it and copy it by hand.";
          },
        )
        .finally(paint);
    });
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
            (caughtError3) => {
              journalCaught(caughtError3, "runners.bind.then", null);
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
          error = `Slots must be from 1 to ${ceiling ?? 16}, the limit set on the runner.`;
          paint();
          return;
        }
        void change(async () => {
          await api(`/api/runners/${encodeURIComponent(runnerId)}/concurrency`, {
            concurrency: value,
          });
          concurrencyDrafts.delete(runnerId);
          feedback = "Slots saved. The runner applies it to new work at its next heartbeat.";
        });
      });
    }
    for (const button of root!.querySelectorAll<HTMLElement>("[data-agent-update]"))
      button.addEventListener("click", () => {
        const { agentUpdate: agent, runner, version } = button.dataset;
        void change(async () => {
          await api(
            `/api/runners/${encodeURIComponent(runner!)}/coding-agents/${encodeURIComponent(agent!)}/update`,
            { version },
          );
          feedback = `${AGENT_NAMES[agent!] ?? agent} ${version} was sent to the runner. It installs at the next heartbeat and switches once no session uses the old version.`;
        });
      });
    root!.querySelector("[data-agents-update-all]")?.addEventListener(
      "click",
      () =>
        void change(async () => {
          const result = await api<{ requested: number }>(
            "/api/runners/coding-agents/update-all",
            {},
          );
          feedback = result.requested
            ? `Sent ${result.requested} coding agent ${result.requested === 1 ? "update" : "updates"} to your runners.`
            : "Every runner already runs or is installing the newest eligible versions.";
        }),
    );
    for (const button of root!.querySelectorAll<HTMLElement>("[data-session-move]"))
      button.addEventListener(
        "click",
        () =>
          void change(async () => {
            await api(
              `/api/runners/${encodeURIComponent(button.dataset.runner!)}/sessions/${encodeURIComponent(button.dataset.sessionMove!)}/move`,
              {},
            );
            feedback =
              "Asked the runner to hand the session over. It moves at the agent's next safe point.";
          }),
      );
    for (const button of root!.querySelectorAll<HTMLElement>("[data-runner-move-all]"))
      button.addEventListener(
        "click",
        () =>
          void change(async () => {
            const result = await api<{ moving: number }>(
              `/api/runners/${encodeURIComponent(button.dataset.runnerMoveAll!)}/sessions/move`,
              {},
            );
            feedback = result.moving
              ? `Asked the runner to hand over ${sessionCount(result.moving)}. Each moves at the agent's next safe point.`
              : "Every session on this runner is already moving.";
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
      stopPolling ??= livePoll(poll, RUNNER_POLL_MS);
      void load();
    },
    refresh() {
      if (!busy) return load();
    },
  };
}
