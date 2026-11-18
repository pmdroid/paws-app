import type { AgentAccountUsage } from "../contract";
import { journalCaught } from "../journal";
import { openAgentAccounts } from "./agent-accounts";
import { openAgentDeviceDialog } from "./agent-device-dialog";
import { readCsrfToken } from "./csrf";
import { esc } from "./format";
import { routeHref } from "./route";
import { renderMarkup } from "./theme";

const AGENTS = { claude: "Claude", codex: "Codex", grok: "Grok", opencode: "OpenCode" } as const;
type Agent = keyof typeof AGENTS;

export type CentralAccount = {
  id: string;
  agent: Agent;
  label: string;
  extraUsage: boolean;
  enabled?: boolean;
  signingIn: boolean;
  health?: "healthy" | "expiring";
  credential: { refreshedAt: number; runner: string | null; expiresAt?: number } | null;
  usage: AgentAccountUsage | null;
};
export type AccountsView = {
  canManage: boolean;
  accounts: CentralAccount[] | null;
  runners: Record<string, string> | null;
  busy: string | null;
  error: string | null;
  rowError?: { id: string; message: string } | null;
  confirm: string | null;
  removing?: string | null;
};

const DAY = 86_400_000;
const NOT_YOURS = new Set([
  "Agent account belongs to another member",
  "Runner belongs to another member",
]);
const CHEVRON = (path: string) =>
  `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"></path></svg>`;
const UP = CHEVRON("m18 15-6-6-6 6");
const DOWN = CHEVRON("m6 9 6 6 6-6");

function when(time: number, withDay: boolean): string {
  return new Date(time).toLocaleString([], {
    ...(withDay ? { weekday: "short" } : {}),
    hour: "2-digit",
    minute: "2-digit",
  });
}

function limitReached(account: CentralAccount) {
  return (account.usage?.limits ?? []).filter((limit) => limit.usedPercent >= 100);
}

function accountBadge(account: CentralAccount): string {
  if (account.enabled === false) return '<span class="pill">Disabled</span>';
  if (account.signingIn) return '<span class="pill running">Signing in</span>';
  if (!account.credential) return '<span class="pill warn">Signed out</span>';
  if (account.health === "expiring") return '<span class="pill warn">Token expiring</span>';
  if (limitReached(account).length)
    return account.extraUsage
      ? '<span class="pill warn">On extra usage</span>'
      : '<span class="pill err">Limit reached</span>';
  return '<span class="pill ok">Signed in</span>';
}

function accountStatus(account: CentralAccount, runners: Record<string, string> | null): string {
  const runner = (id: string | null) => (id ? (runners?.[id] ?? id) : "a runner");
  if (account.enabled === false) return "Disabled · runs skip this account";
  const parts: string[] = [];
  if (account.credential?.expiresAt)
    parts.push(`Token valid until ${new Date(account.credential.expiresAt).toLocaleDateString()}`);
  else if (account.credential)
    parts.push(
      `Refreshed ${when(account.credential.refreshedAt, true)}${account.credential.runner ? ` by ${runner(account.credential.runner)}` : ""}`,
    );
  else if (!account.signingIn)
    parts.push(
      account.agent === "claude" ? "Paste a setup token to sign in" : "Sign in to use this account",
    );
  if (account.health === "expiring") parts.push("paste a new token to renew it");
  return parts.join(" · ");
}

function accountUsage(account: CentralAccount): string {
  const usage = account.usage;
  if (!usage) return account.credential ? '<p class="sub">Usage not reported yet</p>' : "";
  const soon = (time: number) => when(time, time - Date.now() > DAY / 2);
  const meters = usage.limits
    .map((limit) => {
      const used = Math.min(100, Math.max(0, Math.round(limit.usedPercent)));
      const level = used >= 100 ? "full" : used >= 80 ? "high" : "low";
      const reset = limit.resetsAt === null ? "" : `resets ${soon(limit.resetsAt)}`;
      return `<div class="meter-row"><span class="meter-name">${esc(limit.window)}</span><progress class="meter ${level}" max="100" value="${used}" aria-label="${esc(limit.window)} usage ${used}%"></progress><span class="meter-value">${used}%</span><span class="meter-reset">${esc(reset)}</span></div>`;
    })
    .join("");
  const reached = limitReached(account);
  const state = reached.length && account.extraUsage ? "Running on extra usage · " : "";
  const freshness = usage.unavailable
    ? usage.unavailable
    : usage.stale
      ? "Usage may be out of date"
      : `Updated ${Math.max(0, Math.floor((Date.now() - usage.observedAt) / 60000))} min ago`;
  return `<div class="acct-usage" data-account-usage>${meters}<p class="sub">${esc(state + freshness)}</p></div>`;
}

function tokenForm(account: CentralAccount, busy: string): string {
  const fields = `<form class="acct-token-form" data-account-token><label class="field"><span>Setup token</span><input type="password" name="token" required maxlength="512" autocomplete="off" spellcheck="false" placeholder="sk-ant-oat01-…"></label><button class="btn primary" type="submit"${busy}>Save token</button></form><p class="sub">Run <code>claude setup-token</code> on your own machine and paste the token. No runner needed.</p>`;
  return account.credential
    ? `<details class="acct-token"><summary>Replace setup token</summary>${fields}</details>`
    : `<div class="acct-token">${fields}</div>`;
}

function accountCard(account: CentralAccount, index: number, count: number, view: AccountsView) {
  const label = esc(account.label);
  const busy = view.busy ? " disabled" : "";
  const status = accountStatus(account, view.runners);
  const rank =
    count > 1
      ? `<span class="cnt" data-account-rank aria-label="Priority ${index + 1} of ${count}">${index + 1}</span>`
      : "";
  const role =
    count < 2
      ? ""
      : index === 0
        ? "Used first"
        : `Used when ${index === 1 ? "the account above can't" : "the accounts above can't"} run`;
  const roleLine = role ? `<p class="sub" data-account-role>${esc(role)}</p>` : "";
  const error =
    view.rowError?.id === account.id
      ? `<p class="settings-message err" role="alert" data-account-error>${esc(view.rowError.message)}</p>`
      : "";
  const runnerless = view.runners !== null && !Object.keys(view.runners).length;
  const head = `<div class="acct-head"><div class="acct-name">${rank}<div class="acct-title"><strong>${label}</strong>${roleLine}<p class="sub" data-account-status>${esc(status)}</p></div></div>${accountBadge(account)}</div>${accountUsage(account)}${error}`;
  const open = `<li class="acct-item" data-account-id="${esc(account.id)}"`;
  if (!view.canManage) return `${open}><div class="card acct-card">${head}</div></li>`;
  if (view.confirm === account.id)
    return `${open}><div class="card acct-card">${head}<div class="acct-confirm" role="alert"><p>Sign ${label} out on every runner? Runs using it stop at their next request.</p><div class="row"><button class="btn danger" type="button" data-account-action="sign-out-confirm"${busy}>Sign out everywhere</button><button class="btn" type="button" data-account-action="keep">Keep signed in</button></div></div></div></li>`;
  if (view.removing === account.id)
    return `${open}><div class="card acct-card">${head}<div class="acct-confirm" role="alert"><p>Remove ${label}? Paws stops using it and forgets its sign-in. Runs using it stop at their next request.</p><div class="row"><button class="btn danger" type="button" data-account-action="remove-confirm"${busy}>Remove account</button><button class="btn" type="button" data-account-action="keep">Keep account</button></div></div></div></li>`;
  const signIn =
    account.agent === "claude" || (runnerless && account.agent !== "grok")
      ? ""
      : `<button class="btn${account.credential ? "" : " primary"}" type="button" data-account-action="sign-in"${busy}>${account.credential ? "Sign in again" : "Sign in"}</button>`;
  const signOut = account.credential
    ? `<button class="btn" type="button" data-account-action="sign-out"${busy}>Sign out</button>`
    : "";
  const move =
    count > 1
      ? `<div class="acct-move"><button class="btn sm" type="button" data-account-action="up" aria-label="Move ${label} up"${index === 0 ? " disabled" : busy}>${UP}</button><button class="btn sm" type="button" data-account-action="down" aria-label="Move ${label} down"${index === count - 1 ? " disabled" : busy}>${DOWN}</button></div>`
      : "";
  const toggle = `<button class="btn" type="button" data-account-action="${account.enabled === false ? "enable" : "disable"}"${busy}>${account.enabled === false ? "Enable" : "Disable"}</button>`;
  const remove = `<button class="btn danger" type="button" data-account-action="remove"${busy}>Remove</button>`;
  const actions = `<div class="acct-actions">${signIn}${signOut}${toggle}${remove}<label class="acct-extra"><input type="checkbox" data-account-action="extra-usage"${account.extraUsage ? " checked" : ""}${busy}><span>Keep running on extra usage</span></label>${move}</div>`;
  const token = account.agent === "claude" ? tokenForm(account, busy) : "";
  return `${open}${count > 1 ? ' draggable="true"' : ""}><div class="card acct-card">${head}${token}${actions}</div></li>`;
}

export function renderAgentAccountSettings(view: AccountsView): string {
  const message = view.error
    ? `<p class="settings-message err" role="alert">${esc(view.error)}</p>`
    : view.busy
      ? `<p class="settings-message" role="status">${esc(view.busy)}</p>`
      : "";
  if (!view.accounts) return `<section class="acct-page">${message}</section>`;
  const groups = (Object.keys(AGENTS) as Agent[])
    .map((agent) => {
      const rows = view.accounts!.filter((account) => account.agent === agent);
      if (!rows.length) return "";
      const order =
        rows.length > 1
          ? '<p class="sub">Paws uses account 1 first. When it is busy, at its limit, signed out or disabled, the next one takes over. Drag a card or use the arrows to change the order.</p>'
          : "";
      return `<section class="acct-group"><div class="acct-group-head"><h2>${AGENTS[agent]}</h2><span class="cnt">${rows.length}</span></div>${order}<ol class="acct-list" data-agent-group="${agent}">${rows.map((row, index) => accountCard(row, index, rows.length, view)).join("")}</ol></section>`;
    })
    .join("");
  const options = Object.entries(AGENTS).map(
    ([id, name]) => `<option value="${id}">${name}</option>`,
  );
  const add = view.canManage
    ? `<div class="card acct-add"><h2>Add an account</h2><form data-account-add class="acct-add-form"><label class="field"><span>Agent</span><select name="agent">${options.join("")}</select></label><label class="field"><span>Account name</span><input name="label" required maxlength="80" autocomplete="off" placeholder="Work"></label><button class="btn primary" type="submit"${view.busy ? " disabled" : ""}>Add account</button></form></div>`
    : "";
  const runnerless =
    view.canManage && view.runners !== null && !Object.keys(view.runners).length
      ? `<p class="sub" data-account-runnerless><a href="${routeHref({ view: "runners", id: null })}">Add a runner first</a> to sign in to your agent accounts.</p>`
      : "";
  return `<section class="acct-page">${message}${runnerless}${groups || '<p class="empty">No agent accounts yet. Add one below.</p>'}${add}</section>`;
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
    runners: null,
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
      throw Object.assign(
        new Error(result?.error ?? "Agent accounts could not be reached. Try again."),
        { status: response.status },
      );
    return result as T;
  };
  const load = async () => {
    const [listing, listed] = await Promise.all([
      request<{ canManage: boolean; accounts: CentralAccount[] }>("/api/runners/agent-accounts"),
      Promise.all([
        request<{ userId: string }>("/api/auth/session"),
        request<{ runners: { id: string; name: string; ownerUserId: string }[] }>("/api/runners"),
      ]).catch((error) => {
        journalCaught(error, "agent-account-settings.load.runners", null);
        return null;
      }),
    ]);
    view.canManage = listing.canManage;
    view.accounts = listing.accounts;
    view.runners = listed
      ? Object.fromEntries(
          listed[1].runners.flatMap((runner) =>
            runner.ownerUserId === listed[0].userId ? [[runner.id, runner.name]] : [],
          ),
        )
      : null;
    if (!listed) view.error = "Your runners could not be loaded. Reload to try again.";
  };
  const run = async (busy: string, change?: () => Promise<void>, id?: string) => {
    if (!engine || (view.busy && change)) return;
    Object.assign(view, { busy, error: null, confirm: null, removing: null, rowError: null });
    paint();
    try {
      await change?.();
      await load();
    } catch (error) {
      journalCaught(error, "agent-account-settings.run", null);
      const message = error instanceof Error ? error.message : "Try again.";
      if (id && (error as { status?: number }).status === 403 && NOT_YOURS.has(message))
        view.rowError = { id, message };
      else view.error = message;
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
    void run(
      "Saving the order…",
      () => request("/api/runners/agent-accounts/order", "PUT", { agent: account.agent, ids }),
      id,
    );
  };
  const signIn = async (id: string) => {
    const account = view.accounts?.find((entry) => entry.id === id);
    if (!account) return;
    if (account.agent === "codex" || account.agent === "grok") {
      openAgentDeviceDialog(
        AGENTS[account.agent],
        account.label,
        <T>(method: string) =>
          request<T>(`/api/runners/agent-accounts/${encodeURIComponent(id)}/device`, method),
        () => void run("Loading agent accounts…"),
      );
      return;
    }
    const target = await request<{ runnerId: string; bindingId: string; agent: Agent }>(
      `/api/runners/agent-accounts/${encodeURIComponent(id)}/sign-in`,
      "POST",
    );
    open(
      { id: target.runnerId, name: view.runners?.[target.runnerId] ?? target.runnerId },
      target.agent,
      () => void run("Loading agent accounts…"),
      target.bindingId,
      account.label,
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
      void run(
        "Saving extra usage…",
        () =>
          request(`/api/runners/agent-accounts/${encodeURIComponent(id)}/extra-usage`, "PUT", {
            extraUsage: (control as HTMLInputElement).checked,
          }),
        id,
      );
    else if (action === "sign-in") void run("Starting sign-in…", () => signIn(id), id);
    else if (action === "sign-out" || action === "keep") {
      view.confirm = action === "keep" ? null : id;
      view.removing = null;
      paint();
    } else if (action === "remove") {
      view.removing = id;
      view.confirm = null;
      paint();
    } else if (action === "remove-confirm")
      void run(
        "Removing the account…",
        () => request(`/api/runners/agent-accounts/${encodeURIComponent(id)}`, "DELETE"),
        id,
      );
    else if (action === "enable" || action === "disable")
      void run(
        action === "enable" ? "Enabling the account…" : "Disabling the account…",
        () =>
          request(`/api/runners/agent-accounts/${encodeURIComponent(id)}/enabled`, "PUT", {
            enabled: action === "enable",
          }),
        id,
      );
    else if (action === "sign-out-confirm")
      void run(
        "Signing out everywhere…",
        () => request(`/api/runners/agent-accounts/${encodeURIComponent(id)}/credential`, "DELETE"),
        id,
      );
  };
  const submit = (event: Event) => {
    const form = event.target as HTMLFormElement;
    if (form.matches("[data-account-token]")) {
      event.preventDefault();
      const id = form.closest<HTMLElement>("[data-account-id]")?.dataset.accountId;
      const input = form.querySelector<HTMLInputElement>("input")!;
      const token = input.value.trim();
      input.value = "";
      if (id && token)
        void run(
          "Checking the token…",
          () =>
            request(`/api/runners/agent-accounts/${encodeURIComponent(id)}/token`, "PUT", {
              token,
            }),
          id,
        );
      return;
    }
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
