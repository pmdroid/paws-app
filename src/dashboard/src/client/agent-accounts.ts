import { journalCaught } from "../journal";
import { readCsrfToken } from "./csrf";
import { renderMarkup } from "./theme";
import { durationLabel, esc } from "./format";
import { ansiToHtml } from "./ansi";

type Agent = "claude" | "codex" | "grok" | "opencode";
type Login = {
  id: string;
  agent: Agent;
  state: "starting" | "waiting" | "connected" | "failed" | "cancelled" | "expired";
  /** When the person asked for the sign-in. */
  startedAt: number;
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
const NAMES: Record<Agent, string> = {
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
  opencode: "OpenCode",
};

function pending(login: Login | null): boolean {
  return login?.state === "starting" || login?.state === "waiting";
}

export function accountStatus(
  account: Account,
  runnerStatus: string | undefined,
  runnerName: string,
  now: number,
): string {
  const login = account.session;
  if (pending(login))
    return login?.state === "starting"
      ? `Waiting for ${runnerName} to start the sign-in (it's finishing a check). ${durationLabel(Math.floor((now - login.startedAt) / 1000) * 1000)} since you asked.`
      : `Waiting for your sign-in. Expires at ${new Date(login!.expiresAt).toLocaleTimeString()}.`;
  if (account.connected) return "Connected to your account";
  if (runnerStatus === "signed_in") return "Signed in on this runner";
  if (login?.state === "expired") return "Sign-in expired. Start again to connect.";
  if (login?.state === "failed") return "Sign-in failed. Start again to try another sign-in.";
  if (login?.state === "cancelled") return "Sign-in cancelled";
  return "Not connected";
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

export function openAgentAccounts(
  runner: { id: string; name: string },
  agent: string,
  onClose: () => void,
): void {
  if (!(agent in NAMES)) return;
  const name = NAMES[agent as Agent];
  const host = document.createElement("div");
  document.body.append(host);
  renderMarkup(
    host,
    `<dialog id="agent-accounts" aria-labelledby="agent-accounts-heading"><div class="dialog-body"><div class="between"><h2 id="agent-accounts-heading">Sign in to ${name} on ${esc(runner.name)}</h2><button class="btn" type="button" data-account-close>Close</button></div><p data-account-feedback role="alert"></p><div data-account-list class="flex min-w-0 flex-col gap-6"></div><button class="btn" type="button" data-account-refresh>Refresh</button></div></dialog>`,
  );
  const dialog = host.querySelector<HTMLDialogElement>("dialog")!;
  const feedback = dialog.querySelector<HTMLElement>("[data-account-feedback]")!;
  const list = dialog.querySelector<HTMLElement>("[data-account-list]")!;
  const refresh = dialog.querySelector<HTMLButtonElement>("[data-account-refresh]")!;
  let account: Account | null = null;
  let runnerStatus: string | undefined;
  let busy = false;
  let timer = 0;
  let generation = 0;

  function controls() {
    refresh.disabled = busy;
    for (const button of list.querySelectorAll<HTMLButtonElement>("button")) button.disabled = busy;
  }

  function paint() {
    if (!dialog.isConnected || !account) return;
    let row = list.querySelector<HTMLElement>("[data-agent]");
    if (!row) {
      row = document.createElement("div");
      row.dataset.agent = account.agent;
      row.className = "flex min-w-0 flex-col gap-3";
      renderMarkup(
        row,
        `<p data-agent-status role="status" aria-live="polite"></p><p data-agent-running class="muted" hidden></p><div data-agent-actions class="row"></div><div data-agent-authorization class="flex min-w-0 flex-col gap-2"></div><pre data-agent-terminal class="max-h-64 overflow-auto whitespace-pre-wrap break-words" tabindex="0" aria-label="${name} sign-in terminal" hidden></pre><form data-agent-input hidden><label class="field"><span>Reply to ${name}</span><input name="text" autocomplete="off" spellcheck="false" maxlength="4096"></label><button class="btn" type="submit">Send reply</button></form>`,
      );
      list.append(row);
    }
    const login = account.session;
    const active = pending(login);
    row.querySelector<HTMLElement>("[data-agent-status]")!.textContent = accountStatus(
      account,
      runnerStatus,
      runner.name,
      Date.now(),
    );
    const running = row.querySelector<HTMLElement>("[data-agent-running]")!;
    running.textContent = active ? "" : runningNotice(name, account.running);
    running.hidden = !running.textContent;
    const actions = row.querySelector<HTMLElement>("[data-agent-actions]")!;
    const action = active ? "cancel" : "start";
    if (actions.dataset.action !== action) {
      renderMarkup(
        actions,
        `<button class="btn${active ? "" : " primary"}" type="button" data-agent-action="${action}">${active ? "Cancel sign-in" : `Sign in to ${name}`}</button>`,
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
      !active || (account.agent !== "claude" && account.agent !== "opencode");
    const authorization = row.querySelector<HTMLElement>("[data-agent-authorization]")!;
    const challenge =
      active && login ? loginChallenge(account.agent, login.authorization, login.terminal) : null;
    const challengeKey = JSON.stringify(challenge);
    if (authorization.dataset.challenge !== challengeKey) {
      if (challenge) {
        const url = providerUrl(challenge.url, account.agent);
        renderMarkup(
          authorization,
          `<p>${esc(challenge.message)}</p><p class="break-all">${esc(url)}</p><a class="btn primary" href="${esc(url)}" target="_blank" rel="noopener noreferrer" data-agent-open>Open ${name} sign-in</a>`,
        );
      } else renderMarkup(authorization, "");
      authorization.dataset.challenge = challengeKey;
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
      throw new Error(result?.error ?? "Agent sign-in could not be reached. Refresh to try again.");
    return result as T;
  }

  function accountPath(login?: Login | null): string {
    const base = `/api/runners/${encodeURIComponent(runner.id)}/accounts`;
    if (login === undefined) return base;
    return `${base}/${agent}/login${login ? `/${encodeURIComponent(login.id)}` : ""}`;
  }

  function schedule() {
    window.clearTimeout(timer);
    if (!dialog.isConnected) return;
    if (pending(account?.session ?? null))
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
        request<{ accounts: Account[] }>(accountPath()),
        request<{ runners: RunnerSignIns[] }>("/api/runners"),
      ]);
      if (!dialog.isConnected || current !== generation) return;
      account = result.accounts.find((entry) => entry.agent === agent) ?? null;
      runnerStatus = listed.runners
        .find((entry) => entry.id === runner.id)
        ?.agents?.find((entry) => entry.agent === agent)?.status;
      if (!account) feedback.textContent = `${name} is not available on this runner.`;
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

  async function act(action: "start" | "cancel" | "input", input?: unknown) {
    if (busy || !dialog.isConnected || !account) return;
    if (action !== "start" && !pending(account.session)) return;
    busy = true;
    controls();
    feedback.textContent = "";
    const current = ++generation;
    try {
      const login = await request<Login>(
        accountPath(action === "start" ? null : account.session!) +
          (action === "input" ? "/input" : ""),
        action === "cancel" ? "DELETE" : "POST",
        action === "input" ? input : action === "start" ? {} : undefined,
      );
      if (current !== generation) return;
      account.session = login;
      account.connected = login.state === "connected";
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
    if (!target) return;
    if (target.hasAttribute("data-agent-open")) {
      if (busy) event.preventDefault();
      else if (agent === "codex") void act("input", { accept: true });
    } else void act(target.dataset.agentAction as "start" | "cancel");
  });
  dialog.addEventListener("submit", (event) => {
    const form = event.target as HTMLFormElement;
    if (!form.matches("[data-agent-input]")) return;
    event.preventDefault();
    const input = form.querySelector<HTMLInputElement>("input")!;
    const text = input.value;
    if (busy) return;
    input.value = "";
    void act("input", { text: `${text}\r` });
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
