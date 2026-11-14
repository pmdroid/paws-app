import { journalCaught } from "../journal";
import { openAgentAccounts } from "./agent-accounts";
import { readCsrfToken } from "./csrf";
import { esc } from "./format";
import { renderMarkup } from "./theme";

const AGENTS = { claude: "Claude", codex: "Codex", grok: "Grok", opencode: "OpenCode" } as const;
type Agent = keyof typeof AGENTS;

export type CentralAccount = {
  id: string;
  agent: Agent;
  label: string;
  extraUsage: boolean;
  signingIn: boolean;
  credential: { refreshedAt: number; runner: string | null } | null;
  usage: { limits: { window: string; usedPercent: number }[] } | null;
  lease: { runner: string; issue: { identifier: string } | null } | null;
};
export type AccountsView = {
  canManage: boolean;
  accounts: CentralAccount[] | null;
  runners: Record<string, string>;
  busy: string | null;
  error: string | null;
  confirm: string | null;
};

function accountStatus(account: CentralAccount, runners: Record<string, string>): string {
  const runner = (id: string | null) => (id ? (runners[id] ?? id) : "a runner");
  const parts = [
    account.signingIn
      ? "Signing in"
      : account.credential
        ? `Signed in, refreshed ${new Date(account.credential.refreshedAt).toLocaleString()} by ${runner(account.credential.runner)}`
        : "Signed out",
  ];
  if (account.lease)
    parts.push(
      `In use by ${account.lease.issue?.identifier ?? "a run"} on ${runner(account.lease.runner)}`,
    );
  for (const limit of account.usage?.limits ?? [])
    parts.push(`${limit.window}: ${limit.usedPercent}% used`);
  parts.push(account.extraUsage ? "Extra usage on" : "Extra usage off");
  return parts.join(" · ");
}

function accountRow(account: CentralAccount, index: number, count: number, view: AccountsView) {
  const label = esc(account.label);
  const busy = view.busy ? " disabled" : "";
  const status = `<p class="sub" data-account-status>${esc(accountStatus(account, view.runners))}</p>`;
  if (!view.canManage)
    return `<li class="settings-card" data-account-id="${esc(account.id)}"><strong>${label}</strong>${status}</li>`;
  const controls =
    view.confirm === account.id
      ? `<p role="alert">Sign ${label} out on every runner? Runs using it stop at their next request.</p><button class="btn danger" type="button" data-account-action="sign-out-confirm"${busy}>Sign out everywhere</button><button class="btn" type="button" data-account-action="keep">Keep signed in</button>`
      : `<button class="btn" type="button" data-account-action="up" aria-label="Move ${label} up"${index === 0 ? " disabled" : busy}>Up</button><button class="btn" type="button" data-account-action="down" aria-label="Move ${label} down"${index === count - 1 ? " disabled" : busy}>Down</button><label class="row"><input type="checkbox" data-account-action="extra-usage"${account.extraUsage ? " checked" : ""}${busy}><span>Extra usage</span></label><button class="btn primary" type="button" data-account-action="sign-in"${busy}>Sign in</button><button class="btn" type="button" data-account-action="sign-out"${busy || (account.credential ? "" : " disabled")}>Sign out everywhere</button>`;
  return `<li class="settings-card" draggable="true" data-account-id="${esc(account.id)}"><strong>${label}</strong>${status}<div class="row">${controls}</div></li>`;
}

export function renderAgentAccountSettings(view: AccountsView): string {
  const message = view.error
    ? `<p class="settings-message err" role="alert">${esc(view.error)}</p>`
    : view.busy
      ? `<p class="settings-message" role="status">${esc(view.busy)}</p>`
      : "";
  if (!view.accounts) return `<section class="settings-section">${message}</section>`;
  const groups = (Object.keys(AGENTS) as Agent[])
    .map((agent) => {
      const rows = view.accounts!.filter((account) => account.agent === agent);
      if (!rows.length) return "";
      return `<div class="col"><h2>${AGENTS[agent]}</h2><ol class="col" data-agent-group="${agent}">${rows.map((row, index) => accountRow(row, index, rows.length, view)).join("")}</ol></div>`;
    })
    .join("");
  const options = Object.entries(AGENTS).map(
    ([id, name]) => `<option value="${id}">${name}</option>`,
  );
  const add = view.canManage
    ? `<form data-account-add class="row"><label class="field"><span>Agent</span><select name="agent">${options.join("")}</select></label><label class="field"><span>Account name</span><input name="label" required maxlength="80" autocomplete="off"></label><button class="btn" type="submit"${view.busy ? " disabled" : ""}>Add account</button></form>`
    : "";
  return `<section class="settings-section">${message}${groups || '<p class="sub">No agent accounts yet.</p>'}${add}</section>`;
}

export function createAgentAccountSettings(open = openAgentAccounts): {
  mount(root: HTMLElement, engine: string | null): void;
} {
  let root: HTMLElement | null = null;
  let engine: string | null = null;
  let dragged: string | null = null;
  let view: AccountsView = {
    canManage: false,
    accounts: null,
    runners: {},
    busy: null,
    error: null,
    confirm: null,
  };
  const paint = () => {
    if (root) renderMarkup(root, renderAgentAccountSettings(view));
  };
  const request = async <T>(path: string, method = "GET", body?: unknown): Promise<T> => {
    const response = await fetch(new URL(path, engine!), {
      method,
      cache: "no-store",
      headers: {
        ...(method === "GET" ? {} : { "x-paws-csrf": readCsrfToken(document) }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result)
      throw new Error(result?.error ?? "Agent accounts could not be reached. Try again.");
    return result as T;
  };
  const load = async () => {
    const [listing, listed] = await Promise.all([
      request<{ canManage: boolean; accounts: CentralAccount[] }>("/api/runners/agent-accounts"),
      request<{ runners: { id: string; name: string }[] }>("/api/runners").catch((error) => {
        journalCaught(error, "agent-account-settings.load.runners", null);
        return { runners: [] };
      }),
    ]);
    view.canManage = listing.canManage;
    view.accounts = listing.accounts;
    view.runners = Object.fromEntries(listed.runners.map((runner) => [runner.id, runner.name]));
  };
  const run = async (busy: string, change?: () => Promise<void>) => {
    if (!engine || (view.busy && change)) return;
    Object.assign(view, { busy, error: null, confirm: null });
    paint();
    try {
      await change?.();
      await load();
    } catch (error) {
      journalCaught(error, "agent-account-settings.run", null);
      view.error = error instanceof Error ? error.message : "Try again.";
    }
    view.busy = null;
    paint();
  };
  const reorder = (id: string, to: (ids: string[]) => number) => {
    const account = view.accounts?.find((entry) => entry.id === id);
    if (!account) return;
    const ids = view.accounts!.flatMap((entry) =>
      entry.agent === account.agent ? [entry.id] : [],
    );
    const target = to(ids);
    if (target < 0 || target >= ids.length) return;
    ids.splice(ids.indexOf(id), 1);
    ids.splice(target, 0, id);
    void run("Saving the order…", () =>
      request("/api/runners/agent-accounts/order", "PUT", { agent: account.agent, ids }),
    );
  };
  const signIn = async (id: string) => {
    const target = await request<{ runnerId: string; bindingId: string; agent: Agent }>(
      `/api/runners/agent-accounts/${encodeURIComponent(id)}/sign-in`,
      "POST",
    );
    open(
      { id: target.runnerId, name: view.runners[target.runnerId] ?? target.runnerId },
      target.agent,
      () => void run("Loading agent accounts…"),
      target.bindingId,
    );
  };
  const click = (event: Event) => {
    const control = (event.target as Element).closest<HTMLElement>("[data-account-action]");
    const id = control?.closest<HTMLElement>("[data-account-id]")?.dataset.accountId;
    if (!control || !id) return;
    const action = control.dataset.accountAction;
    if (action === "up" || action === "down")
      reorder(id, (ids) => ids.indexOf(id) + (action === "up" ? -1 : 1));
    else if (action === "extra-usage")
      void run("Saving extra usage…", () =>
        request(`/api/runners/agent-accounts/${encodeURIComponent(id)}/extra-usage`, "PUT", {
          extraUsage: (control as HTMLInputElement).checked,
        }),
      );
    else if (action === "sign-in") void run("Finding one of your runners…", () => signIn(id));
    else if (action === "sign-out" || action === "keep") {
      view.confirm = action === "keep" ? null : id;
      paint();
    } else if (action === "sign-out-confirm")
      void run("Signing out everywhere…", () =>
        request(`/api/runners/agent-accounts/${encodeURIComponent(id)}/credential`, "DELETE"),
      );
  };
  const submit = (event: Event) => {
    const form = event.target as HTMLFormElement;
    if (!form.matches("[data-account-add]")) return;
    event.preventDefault();
    const agent = form.querySelector<HTMLSelectElement>("select")!.value;
    const label = form.querySelector<HTMLInputElement>("input")!.value.trim();
    if (label)
      void run("Adding the account…", () =>
        request("/api/runners/agent-accounts", "POST", { agent, label }),
      );
  };
  const dragstart = (event: Event) => {
    dragged =
      (event.target as Element).closest<HTMLElement>("[data-account-id]")?.dataset.accountId ??
      null;
  };
  const dragover = (event: Event) => {
    if (dragged && (event.target as Element).closest("[data-account-id]")) event.preventDefault();
  };
  const drop = (event: Event) => {
    const over = (event.target as Element).closest<HTMLElement>("[data-account-id]")?.dataset
      .accountId;
    const from = dragged;
    dragged = null;
    if (!from || !over || from === over) return;
    event.preventDefault();
    reorder(from, (ids) => (ids.includes(over) ? ids.indexOf(over) : -1));
  };
  const listeners = { click, submit, dragstart, dragover, drop };
  return {
    mount(next, nextEngine) {
      if (root === next && engine === nextEngine) return;
      for (const [name, listener] of Object.entries(listeners))
        root?.removeEventListener(name, listener);
      if (engine !== nextEngine) view = { ...view, accounts: null, error: null, confirm: null };
      root = next;
      engine = nextEngine;
      for (const [name, listener] of Object.entries(listeners))
        root.addEventListener(name, listener);
      if (!engine) {
        view.error = "Connect to your Paws dashboard to manage agent accounts.";
        paint();
      } else if (!view.accounts && !view.busy) void run("Loading agent accounts…");
      else paint();
    },
  };
}
