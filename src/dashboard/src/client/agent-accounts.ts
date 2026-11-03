import { journalCaught } from "../journal";
import { readCsrfToken } from "./csrf";
import { renderMarkup } from "./theme";
import { esc } from "./format";
import { ansiToHtml } from "./ansi";

type Agent = "claude" | "codex" | "grok" | "opencode";
type Login = {
  id: string;
  agent: Agent;
  state: "starting" | "waiting" | "connected" | "failed" | "cancelled" | "expired";
  expiresAt: number;
  terminal: string;
  authorization: { url: string; message: string } | null;
};
type Account = {
  agent: Agent;
  connected: boolean;
  /** Tasks this agent is running on the runner now. */
  running?: number;
  session: Login | null;
};
type RunnerSignIns = { id: string; agents?: { agent: string; status: string }[] };
type NamedBinding = {
  bindingId: string;
  accountId: string;
  agent: Agent;
  label: string;
  enabled: boolean;
  held?: boolean;
  running?: number;
  session: Login | null;
};
export type SignInSlot = {
  key: string;
  agent: Agent;
  bindingId: string | null;
  title: string;
  connected: boolean;
  running?: number;
  enabled: boolean;
  session: Login | null;
};

const NAMES: Record<Agent, string> = {
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
  opencode: "OpenCode",
};

function pending(login: Login | null): boolean {
  return login?.state === "starting" || login?.state === "waiting";
}

export function accountStatus(account: Account, runnerStatus: string | undefined): string {
  const login = account.session;
  if (pending(login))
    return login?.state === "starting"
      ? "Starting sign-in…"
      : `Waiting for your sign-in. Expires at ${new Date(login!.expiresAt).toLocaleTimeString()}.`;
  if (account.connected) return "Connected to your account";
  if (runnerStatus === "signed_in") return "Signed in on this runner";
  if (login?.state === "expired") return "Sign-in expired. Start again to connect.";
  if (login?.state === "failed") return "Sign-in failed. Start again to try another sign-in.";
  if (login?.state === "cancelled") return "Sign-in cancelled";
  return "Not connected";
}

export function namedStatus(binding: NamedBinding): string {
  const login = binding.session;
  const base = pending(login)
    ? accountStatus({ agent: binding.agent, connected: false, session: login }, undefined)
    : login?.state === "connected" || binding.held
      ? "Signed in on this runner"
      : login?.state === "failed"
        ? "Sign-in failed. The previous sign-in, if any, is kept."
        : login?.state === "cancelled" || login?.state === "expired"
          ? "Sign-in not finished. The previous sign-in, if any, is kept."
          : "Not signed in on this runner";
  return binding.enabled ? base : `${base} Disabled: new work skips this account.`;
}

export function signInSlots(
  accounts: readonly Account[],
  bindings: readonly NamedBinding[],
): SignInSlot[] {
  return (["claude", "codex", "grok", "opencode"] as const).flatMap((agent) => {
    const account = accounts.find((entry) => entry.agent === agent);
    if (!account) return [];
    return [
      {
        key: agent,
        agent,
        bindingId: null,
        title: bindings.some((binding) => binding.agent === agent)
          ? `${NAMES[agent]} default sign-in`
          : NAMES[agent],
        connected: account.connected,
        ...(account.running === undefined ? {} : { running: account.running }),
        enabled: true,
        session: account.session,
      },
      ...bindings
        .filter((binding) => binding.agent === agent)
        .map((binding) => ({
          key: `${agent}:${binding.bindingId}`,
          agent,
          bindingId: binding.bindingId,
          title: `${NAMES[agent]}: ${binding.label}`,
          connected: binding.held === true,
          ...(binding.running === undefined ? {} : { running: binding.running }),
          enabled: binding.enabled,
          session: binding.session,
        })),
    ];
  });
}

/** Said before a sign-in starts while the agent is running tasks on the runner. */
export function runningNotice(name: string, running: number | undefined): string {
  if (!running) return "";
  const [tasks, them, their] = running === 1 ? ["task", "it", "its"] : ["tasks", "them", "their"];
  return `${name} is running ${running} ${tasks} on this runner. Signing in switches ${them} to the new account from ${their} next request.`;
}

const CLAUDE_HOSTS = ["claude.ai", "claude.com", "console.anthropic.com", "platform.claude.com"];
const TERMINAL_URL = /https:\/\/[\w\-.~:/?#[\]@!$&()*+,;=%]+/g;

export function terminalMarkup(terminal: string): string {
  return ansiToHtml(terminal);
}

export function loginChallenge(
  agent: Agent,
  authorization: { url: string; message: string } | null,
  terminal: string,
): { url: string; message: string } | null {
  if (authorization || agent !== "claude") return authorization;
  const url = [...terminal.matchAll(TERMINAL_URL)]
    .map((match) => match[0])
    .find(
      (candidate) => URL.canParse(candidate) && CLAUDE_HOSTS.includes(new URL(candidate).hostname),
    );
  return url ? { url, message: "Sign in to Claude, then paste the code it shows below." } : null;
}

export function openAgentAccounts(runner: { id: string; name: string }, onClose: () => void): void {
  const host = document.createElement("div");
  document.body.append(host);
  renderMarkup(
    host,
    `<dialog id="agent-accounts" aria-labelledby="agent-accounts-heading"><div class="dialog-body"><div class="between"><h2 id="agent-accounts-heading">Sign in on ${esc(runner.name)}</h2><button class="btn" type="button" data-account-close>Close</button></div><p class="sub">Connect Claude, Codex, Grok, and OpenCode on this runner. Named accounts linked to this runner in Settings › Agents are listed under their agent, each with its own sign-in.</p><p data-account-feedback role="alert"></p><div data-account-list class="flex min-w-0 flex-col gap-6"></div><button class="btn" type="button" data-account-refresh>Refresh accounts</button></div></dialog>`,
  );
  const dialog = host.querySelector<HTMLDialogElement>("dialog")!;
  const feedback = dialog.querySelector<HTMLElement>("[data-account-feedback]")!;
  const list = dialog.querySelector<HTMLElement>("[data-account-list]")!;
  const refresh = dialog.querySelector<HTMLButtonElement>("[data-account-refresh]")!;
  let accounts: Account[] = [];
  let bindings: NamedBinding[] = [];
  let slots: SignInSlot[] = [];
  let runnerStatus = new Map<string, string>();
  let busy = false;
  let timer = 0;
  let generation = 0;

  function controls() {
    refresh.disabled = busy;
    for (const button of list.querySelectorAll<HTMLButtonElement>("button")) button.disabled = busy;
  }

  function status(slot: SignInSlot): string {
    if (slot.bindingId === null) {
      const account = accounts.find((entry) => entry.agent === slot.agent)!;
      return accountStatus(account, runnerStatus.get(slot.agent));
    }
    return namedStatus(bindings.find((entry) => entry.bindingId === slot.bindingId)!);
  }

  function paint() {
    if (!dialog.isConnected) return;
    slots = signInSlots(accounts, bindings);
    for (const row of list.querySelectorAll<HTMLElement>("[data-slot]"))
      if (!slots.some((slot) => slot.key === row.dataset.slot)) row.remove();
    for (const slot of slots) {
      const { agent } = slot;
      const name = NAMES[agent];
      let row = [...list.querySelectorAll<HTMLElement>("[data-slot]")].find(
        (entry) => entry.dataset.slot === slot.key,
      );
      if (!row) {
        row = document.createElement("div");
        row.dataset.slot = slot.key;
        row.dataset.agent = agent;
        row.className = "flex min-w-0 flex-col gap-3";
        renderMarkup(
          row,
          `<h3 class="break-words">${esc(slot.title)}</h3><p data-agent-status role="status" aria-live="polite"></p><p data-agent-running class="muted" hidden></p><div data-agent-actions class="row"></div><div data-agent-authorization class="flex min-w-0 flex-col gap-2"></div><pre data-agent-terminal class="max-h-64 overflow-auto whitespace-pre-wrap break-words" tabindex="0" aria-label="${esc(slot.title)} sign-in terminal" hidden></pre><form data-agent-input hidden><label class="field"><span>Reply to ${name}</span><input name="text" autocomplete="off" spellcheck="false" maxlength="4096"></label><button class="btn" type="submit">Send reply</button></form>`,
        );
        list.append(row);
      }
      const login = slot.session;
      const active = pending(login);
      row.querySelector<HTMLElement>("[data-agent-status]")!.textContent = status(slot);
      const running = row.querySelector<HTMLElement>("[data-agent-running]")!;
      running.textContent = active
        ? ""
        : slot.bindingId === null
          ? runningNotice(name, slot.running)
          : slot.running
            ? `This account is running ${slot.running} ${slot.running === 1 ? "task" : "tasks"} on this runner. Sign in again once ${slot.running === 1 ? "it finishes" : "they finish"}.`
            : "";
      running.hidden = !running.textContent;
      const actions = row.querySelector<HTMLElement>("[data-agent-actions]")!;
      const action = active ? "cancel" : "start";
      if (actions.dataset.action !== action) {
        renderMarkup(
          actions,
          `<button class="btn${active ? "" : " primary"}" type="button" data-agent-action="${action}">${active ? "Cancel sign-in" : slot.bindingId === null ? `Sign in to ${name}` : "Sign in to this account"}</button>`,
        );
        actions.dataset.action = action;
      }
      const terminal = row.querySelector<HTMLElement>("[data-agent-terminal]")!;
      const output = active ? (login?.terminal ?? "") : "";
      if (terminal.dataset.output !== output) {
        renderMarkup(terminal, terminalMarkup(output));
        terminal.dataset.output = output;
      }
      terminal.hidden = !output;
      row.querySelector<HTMLElement>("[data-agent-input]")!.hidden =
        !active || (agent !== "claude" && agent !== "opencode");
      const authorization = row.querySelector<HTMLElement>("[data-agent-authorization]")!;
      const challenge =
        active && login ? loginChallenge(agent, login.authorization, login.terminal) : null;
      const challengeKey = JSON.stringify(challenge);
      if (authorization.dataset.challenge !== challengeKey) {
        if (challenge) {
          const url = providerUrl(challenge.url, agent);
          renderMarkup(
            authorization,
            `<p>${esc(challenge.message)}</p><p class="break-all">${esc(url)}</p><a class="btn primary" href="${esc(url)}" target="_blank" rel="noopener noreferrer" data-agent-open>Open ${name} sign-in</a>`,
          );
        } else renderMarkup(authorization, "");
        authorization.dataset.challenge = challengeKey;
      }
    }
    controls();
  }

  async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const response = await fetch(path, {
      method,
      cache: "no-store",
      headers: {
        ...(method === "GET" ? {} : { "x-paws-csrf": readCsrfToken(document) }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json().catch((caughtError1) => {
      journalCaught(caughtError1, "agent-accounts.request.json", null);
      return null;
    });
    if (!response.ok || !result)
      throw new Error(
        result?.error ?? "Agent accounts could not be reached. Refresh to try again.",
      );
    return result as T;
  }

  function accountPath(slot?: SignInSlot, login?: Login): string {
    const base = `/api/runners/${encodeURIComponent(runner.id)}/accounts`;
    if (!slot) return base;
    const path = `${base}/${slot.agent}/login${login ? `/${encodeURIComponent(login.id)}` : ""}`;
    return !login && slot.bindingId
      ? `${path}?binding=${encodeURIComponent(slot.bindingId)}`
      : path;
  }

  function schedule() {
    window.clearTimeout(timer);
    if (!dialog.isConnected) return;
    if (slots.some((slot) => pending(slot.session)))
      timer = window.setTimeout(() => {
        if (document.visibilityState === "visible") void load();
        else schedule();
      }, 2000);
  }

  async function load() {
    if (busy || !dialog.isConnected) return;
    const current = ++generation;
    busy = true;
    controls();
    feedback.textContent = "";
    try {
      const [result, listed] = await Promise.all([
        request<{ accounts: Account[]; bindings?: NamedBinding[] }>(accountPath()),
        request<{ runners: RunnerSignIns[] }>("/api/runners"),
      ]);
      if (!dialog.isConnected || current !== generation) return;
      accounts = result.accounts;
      bindings = result.bindings ?? [];
      runnerStatus = new Map(
        (listed.runners.find((entry) => entry.id === runner.id)?.agents ?? []).map((entry) => [
          entry.agent,
          entry.status,
        ]),
      );
      paint();
    } catch (error) {
      journalCaught(error, "agent-accounts.load.all", null);
      feedback.textContent = error instanceof Error ? error.message : "Refresh to try again.";
    } finally {
      busy = false;
      controls();
      schedule();
    }
  }

  async function act(key: string, action: "start" | "cancel" | "input", input?: unknown) {
    if (busy || !dialog.isConnected) return;
    const slot = slots.find((entry) => entry.key === key);
    if (!slot || (action !== "start" && !pending(slot.session))) return;
    busy = true;
    controls();
    feedback.textContent = "";
    const current = ++generation;
    try {
      const login = await request<Login>(
        accountPath(slot, action === "start" ? undefined : slot.session!) +
          (action === "input" ? "/input" : ""),
        action === "cancel" ? "DELETE" : "POST",
        action === "input" ? input : action === "start" ? {} : undefined,
      );
      if (current !== generation) return;
      if (slot.bindingId === null) {
        const account = accounts.find((entry) => entry.agent === slot.agent)!;
        account.session = login;
        account.connected = login.state === "connected";
      } else {
        const binding = bindings.find((entry) => entry.bindingId === slot.bindingId)!;
        binding.session = login;
        if (login.state === "connected") binding.held = true;
      }
      paint();
    } catch (error) {
      journalCaught(error, "agent-accounts.act.request", null);
      feedback.textContent = error instanceof Error ? error.message : "Refresh to try again.";
    } finally {
      busy = false;
      controls();
      schedule();
    }
  }

  refresh.addEventListener("click", () => void load());
  dialog.querySelector("[data-account-close]")!.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    window.clearTimeout(timer);
    renderMarkup(host, "");
    host.remove();
    onClose();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      dialog.close();
      return;
    }
    const target = (event.target as Element).closest<HTMLElement>(
      "[data-agent-action], [data-agent-open]",
    );
    const row = target?.closest<HTMLElement>("[data-slot]");
    const key = row?.dataset.slot;
    const agent = row?.dataset.agent as Agent | undefined;
    if (!target || !key || !agent) return;
    if (target.hasAttribute("data-agent-open")) {
      if (busy) event.preventDefault();
      else if (agent === "codex") void act(key, "input", { accept: true });
    } else void act(key, target.dataset.agentAction as "start" | "cancel");
  });
  dialog.addEventListener("submit", (event) => {
    const form = event.target as HTMLFormElement;
    if (!form.matches("[data-agent-input]")) return;
    event.preventDefault();
    const key = form.closest<HTMLElement>("[data-slot]")!.dataset.slot!;
    const input = form.querySelector<HTMLInputElement>("input")!;
    const text = input.value;
    if (busy) return;
    input.value = "";
    void act(key, "input", { text: `${text}\r` });
  });
  dialog.showModal();
  void load();
}

function providerUrl(value: string, agent: Agent): string {
  const url = new URL(value);
  const hosts =
    agent === "codex"
      ? ["auth.openai.com", "chatgpt.com"]
      : agent === "grok"
        ? ["accounts.x.ai", "auth.x.ai"]
        : CLAUDE_HOSTS;
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !hosts.includes(url.hostname)
  )
    throw new Error("The agent returned an unexpected sign-in link. Cancel and try again.");
  return url.href;
}
