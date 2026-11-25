import { journalCaught } from "../journal";
import { readCsrfToken } from "./csrf";
import { ago, clock, esc } from "./format";
import { routeHref } from "./route";
import type { Runner } from "./runners";
import { renderMarkup } from "./theme";

type Name = "exe-dev" | "boat" | "instabox" | "tailscale";
type Provider = Exclude<Name, "tailscale">;
type Fact = { name: string; text: string; level: "ok" | "warn" | "error" };
type Check = {
  state: "working" | "limited" | "rejected" | "unreachable";
  message: string;
  facts: Fact[];
  checkedAt: number;
  lastWorkingAt: number | null;
};
type Vm = { vmName: string; runnerId: string | null; step: string };
type Entry = { set: boolean; off?: boolean; vms?: Vm[]; check: Check | null };
type Status = Record<Name, Entry> & { nextCheckAt: number | null };

const PROVIDERS: Provider[] = ["exe-dev", "boat", "instabox"];
const KEY: Record<Name, string> = {
  "exe-dev": "exeDev",
  boat: "boat",
  instabox: "instabox",
  tailscale: "tailscale",
};
const TITLE: Record<Name, string> = {
  "exe-dev": "exe.dev",
  boat: "boat",
  instabox: "InstaBox",
  tailscale: "Tailscale",
};
const KEY_LABEL: Record<Name, string> = {
  "exe-dev": "exe.dev API token",
  boat: "boat API key",
  instabox: "InstaBox API key",
  tailscale: "Tailscale auth key",
};
const HELP: Record<Name, string> = {
  "exe-dev": "Create VM uses it to make runner VMs on exe.dev.",
  boat: "Create VM uses it to make runner VMs on boat. It needs to create, read, stop, resume and delete sandboxes, and to run commands.",
  instabox:
    "Create VM uses it to make runner VMs on InstaBox. It needs the scopes machines:read, machines:write and machines:delete.",
  tailscale:
    'Runner VMs join your tailnet with it. Make it reusable and pre-authorized, tagged <code>tag:paws-runner</code>. In the tailnet policy, add <code>"tagOwners": { "tag:paws-runner": ["autogroup:admin"] }</code> and <code>{ "action": "accept", "src": ["tag:paws-runner"], "dst": ["paws:8787,8788"] }</code>.',
};
const BADGE: Record<string, [string, string, string]> = {
  working: ["ok", "✓", "Working"],
  limited: ["warn", "!", "Limited"],
  rejected: ["rejected", "✕", "Key rejected"],
  unreachable: ["err", "⚠", "Can't reach"],
  off: ["", "○", "Off"],
  missing: ["", "–", "Not connected"],
  unchecked: ["", "…", "Not checked yet"],
};
const FACT: Record<string, string> = {
  key: "Key",
  plan: "Plan",
  sizes: "Sizes",
  vms: "VMs",
  stopped_vms: "Stopped VMs",
  join: "Last join",
};
const LEVEL: Record<Fact["level"], string> = {
  ok: "",
  warn: "text-state-awaiting",
  error: "text-state-failed",
};

const badge = (state: string) => {
  const [tone, icon, word] = BADGE[state]!;
  return `<span class="st ${tone}" data-provider-state><span aria-hidden="true">${icon}</span>${word}</span>`;
};
const stateOf = (entry: Entry) =>
  !entry.set ? "missing" : entry.off ? "off" : (entry.check?.state ?? "unchecked");
const when = (at: number) => ago(new Date(at).toISOString(), new Date().toISOString());

function facts(check: Check | null) {
  if (!check?.facts.length) return "";
  const items = check.facts
    .map(
      (fact) =>
        `<div class="min-w-0"><dt class="muted">${esc(FACT[fact.name] ?? fact.name)}</dt><dd class="m-0 text-sm ${LEVEL[fact.level]}">${esc(fact.text)}</dd></div>`,
    )
    .join("");
  return `<dl class="m-0 grid min-w-0 grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-3" data-provider-facts>${items}</dl>`;
}

function alert(check: Check | null) {
  return check && (check.state === "rejected" || check.state === "unreachable")
    ? `<p class="settings-message err text-state-failed" role="alert">${esc(check.message)}</p>`
    : "";
}

export function createRunnerVmKeys() {
  let root: HTMLElement | undefined;
  let engine = "";
  let status: Status | null = null;
  let fleet: Runner[] = [];
  let connecting: Name | null = null;
  let replacing: Name | null = null;
  let found: Check | null | undefined;
  let busy: string | null = null;
  let message = "";
  let failed = false;

  const keyForm = (name: Name, submit: string) =>
    `<form class="col" data-runner-vm-key="${KEY[name]}"><div class="settings-field"><label for="runner-vm-${KEY[name]}">${KEY_LABEL[name]}</label><input id="runner-vm-${KEY[name]}" name="${KEY[name]}" type="password" required autocomplete="off" spellcheck="false"></div><p class="muted">${HELP[name]}</p><div class="row"><button class="btn primary" type="submit"${busy ? " disabled" : ""}>${submit}</button><button class="btn" type="button" data-cancel>Cancel</button></div></form>`;

  const toggle = (name: Provider, entry: Entry) =>
    `<label class="settings-inherit"><input type="checkbox" role="switch" data-provider-on="${name}"${entry.off ? "" : " checked"}${busy ? " disabled" : ""}><span class="min-w-0 flex-1">Make new VMs here</span></label>`;

  const runners = (name: Provider) => {
    const list = status![name].vms;
    if (list === undefined)
      return '<p class="muted" data-provider-runners-unavailable>Runners could not be listed.</p>';
    if (list.length === 0) return `<p class="muted">No runners on ${TITLE[name]}.</p>`;
    return `<ul class="m-0 list-none p-0" aria-label="Runners on ${TITLE[name]}" data-provider-runners>${list
      .map((vm) => {
        const runner = fleet.find((r) => r.id === vm.runnerId);
        const cpus = runner?.metrics?.cpuCount;
        const memory = runner?.metrics?.memoryTotalBytes;
        const size =
          [
            cpus ? `${cpus} ${cpus === 1 ? "CPU" : "CPUs"}` : "",
            memory ? `${Math.round(memory / 1024 ** 3)} GB` : "",
          ]
            .filter(Boolean)
            .join(" · ") || "Size not reported";
        const state = vm.step !== "ready" || !runner ? vm.step : runner.status;
        return `<li class="between"><span class="min-w-0 font-semibold">${esc(runner?.name ?? vm.vmName)}</span><span class="row"><span class="muted">${esc(size)}</span><span class="tag">${esc(state)}</span></span></li>`;
      })
      .join("")}</ul>`;
  };

  const connectSteps = (name: Name) => {
    const entry = status![name];
    const saved = found !== undefined;
    const step = (n: number, title: string, body: string) =>
      `<li class="col"><h4>${n}. ${title}</h4>${body}</li>`;
    const result = !saved
      ? '<p class="muted">Paws checks the key when you save it.</p>'
      : found
        ? `<div class="col" data-connect-result>${badge(found.state)}<p>${esc(found.message)}</p>${facts(found)}</div>`
        : '<p class="muted" data-connect-result>Saved. Paws checks the key on its next round.</p>';
    const on =
      name === "tailscale"
        ? ""
        : step(
            3,
            "Turn it on",
            `${saved ? toggle(name, entry) : '<p class="muted">Save the key first.</p>'}<p class="muted">New VMs use the default size in <a href="${routeHref({ view: "workspace", page: "member-vm" })}">Settings › Member VMs</a>.</p>`,
          );
    return `<ol class="m-0 col list-none p-0" data-connect="${name}">${step(1, "Paste the key", saved ? '<p class="muted">Key saved.</p>' : keyForm(name, "Save and check"))}${step(2, "See what Paws found", result)}${on}</ol>${saved ? '<div class="row"><button class="btn" type="button" data-cancel>Done</button></div>' : ""}`;
  };

  const card = (name: Name) => {
    const entry = status![name];
    const check = entry.check;
    const head = `<div class="between"><h3>${TITLE[name]}</h3>${badge(stateOf(entry))}</div>`;
    if (connecting === name)
      return `<article class="card col" data-vm-provider="${name}">${head}${connectSteps(name)}</article>`;
    if (!entry.set)
      return `<article class="card col" data-vm-provider="${name}">${head}<p class="muted">${HELP[name]}</p><div class="row"><button class="btn primary" type="button" data-connect-open="${name}">Connect</button></div></article>`;
    const checked = check
      ? `<p class="muted" data-checked>Checked ${when(check.checkedAt)}</p>`
      : `<p class="muted" data-checked>${name === "tailscale" ? "No runner VM has joined with this key yet." : "Not checked yet."}</p>`;
    const actions = `<div class="row">${name === "tailscale" ? "" : `<button class="btn" type="button" data-check="${name}"${busy ? " disabled" : ""}>${busy === `check:${name}` ? "Checking…" : "Check now"}</button>`}<button class="btn" type="button" data-replace="${name}">Replace key</button><button class="btn" type="button" data-clear="${KEY[name]}"${busy ? " disabled" : ""}>Remove key</button></div>`;
    const tail =
      name === "tailscale"
        ? `<p class="muted">No switch: every provider joins runner VMs to your tailnet with this key, so it can't be turned off. Facts come from the last join.</p>${replacing === name ? "" : `<details><summary>Tailnet requirements</summary><p class="muted">${HELP.tailscale}</p></details>`}`
        : `<div class="col"><h4>Runners</h4>${runners(name)}</div>${toggle(name, entry)}`;
    return `<article class="card col" data-vm-provider="${name}">${head}${checked}${facts(check)}${alert(check)}${actions}${replacing === name ? keyForm(name, "Save and check") : ""}${tail}</article>`;
  };

  const summary = () => {
    const s = status!;
    const working = PROVIDERS.filter((name) =>
      ["working", "limited"].includes(stateOf(s[name])),
    ).length;
    const next =
      s.nextCheckAt === null
        ? "No check is scheduled."
        : `Next check at ${clock(new Date(s.nextCheckAt).toISOString())}.`;
    return `<p class="sub" data-vm-summary>${working} of ${PROVIDERS.length} VM providers working. ${next}</p>`;
  };

  const paint = () => {
    if (!root) return;
    const note = message
      ? `<p class="settings-message${failed ? " err" : ""}" role="${failed ? "alert" : "status"}">${esc(message)}</p>`
      : "";
    const body = status
      ? `${summary()}${note}<section class="col" aria-labelledby="vm-providers-heading"><h2 id="vm-providers-heading">VM providers</h2><div class="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-2 [&>*]:min-w-0">${PROVIDERS.map(card).join("")}</div></section><section class="col" aria-labelledby="vm-network-heading"><h2 id="vm-network-heading">Network</h2>${card("tailscale")}</section>`
      : note || '<p class="muted">Loading VM providers…</p>';
    renderMarkup(root, `<div class="col">${body}</div>`);
  };

  const call = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(new URL(path, engine), {
      method,
      cache: "no-store",
      headers: { "Content-Type": "application/json", "x-paws-csrf": readCsrfToken(document) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status}).`);
    return data;
  };

  const loadRunners = async () => {
    const list = (await call("/api/runners").catch(() => ({}))) as { runners?: Runner[] };
    fleet = list.runners ?? [];
  };

  const run = async (key: string, done: string, work: () => Promise<string | void>) => {
    busy = key;
    paint();
    try {
      message = (await work()) || done;
      failed = false;
    } catch (error) {
      journalCaught(error, "runner-vm-keys.request", null);
      message = error instanceof Error ? error.message : "Try again.";
      failed = true;
    }
    busy = null;
    paint();
  };

  const load = () =>
    run("load", "", async () => {
      [, status] = await Promise.all([loadRunners(), call("/api/settings/vm-providers")]);
    });

  const nameOf = (key: string) => (Object.keys(KEY) as Name[]).find((name) => KEY[name] === key)!;

  const submit = (event: Event) => {
    const form = event.target as HTMLFormElement;
    const key = form.dataset.runnerVmKey;
    if (!key) return;
    event.preventDefault();
    const value = form.querySelector("input")!.value;
    const name = nameOf(key);
    void run(`save:${name}`, "", async () => {
      const saved = await call("/api/settings/runner-vm-keys", "PUT", { [key]: value });
      status = await call("/api/settings/vm-providers");
      if (connecting === name) {
        found = saved.check ?? null;
        return;
      }
      replacing = null;
      return saved.check?.message ?? `Saved the ${KEY_LABEL[name]}.`;
    });
  };

  const change = (event: Event) => {
    const input = event.target as HTMLInputElement;
    const provider = input.dataset.providerOn as Provider | undefined;
    if (!provider) return;
    const on = input.checked;
    void run(
      `switch:${provider}`,
      `${TITLE[provider]} is ${on ? "on" : "off"} for new VMs.`,
      async () => {
        status = await call("/api/settings/vm-providers", "PUT", { provider, off: !on });
      },
    );
  };

  const click = (event: Event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-check],[data-replace],[data-clear],[data-connect-open],[data-cancel]",
    );
    if (!target) return;
    const { check, replace, clear, connectOpen } = target.dataset;
    if (check)
      void run(`check:${check}`, `Checked ${TITLE[check as Name]}.`, async () => {
        status = await call("/api/settings/vm-providers/check", "POST", { key: check });
      });
    else if (clear)
      void run(`clear:${clear}`, `Removed the ${KEY_LABEL[nameOf(clear)]}.`, async () => {
        await call(`/api/settings/runner-vm-keys?key=${clear}`, "DELETE");
        status = await call("/api/settings/vm-providers");
      });
    else {
      replacing = (replace as Name | undefined) ?? null;
      connecting = (connectOpen as Name | undefined) ?? null;
      found = undefined;
      message = "";
      paint();
    }
  };

  return {
    mount(next: HTMLElement, nextEngine: string | null) {
      if ((root === next && engine === nextEngine) || !nextEngine) return;
      root?.removeEventListener("submit", submit);
      root?.removeEventListener("click", click);
      root?.removeEventListener("change", change);
      root = next;
      engine = nextEngine;
      status = null;
      connecting = replacing = null;
      message = "";
      root.addEventListener("submit", submit);
      root.addEventListener("click", click);
      root.addEventListener("change", change);
      void load();
    },
  };
}
