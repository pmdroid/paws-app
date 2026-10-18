import { readCsrfToken } from "./github-auth";
import { renderMarkup } from "./theme";
import { esc } from "./format";

type Agent = "claude" | "codex";
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
  updatedAt: number | null;
  session: Login | null;
};

export function openAgentAccounts(runner: { id: string; name: string }, onClose: () => void): void {
  const host = document.createElement("div");
  document.body.append(host);
  renderMarkup(
    host,
    `<dialog id="agent-accounts" aria-labelledby="agent-accounts-heading"><div class="dialog-body"><div class="between"><h2 id="agent-accounts-heading">Sign in on ${esc(runner.name)}</h2><button class="btn" type="button" data-account-close>Close</button></div><p class="sub">Connect Claude and Codex on this runner. Each member signs in separately.</p><p data-account-feedback role="alert"></p><div data-account-list class="flex min-w-0 flex-col gap-6"></div><button class="btn" type="button" data-account-refresh>Refresh accounts</button></div></dialog>`,
  );
  const dialog = host.querySelector<HTMLDialogElement>("dialog")!;
  const feedback = dialog.querySelector<HTMLElement>("[data-account-feedback]")!;
  const list = dialog.querySelector<HTMLElement>("[data-account-list]")!;
  const refresh = dialog.querySelector<HTMLButtonElement>("[data-account-refresh]")!;
  let accounts: Account[] = [];
  let busy = false;
  let timer = 0;
  let generation = 0;

  function pending(login: Login | null): boolean {
    return login?.state === "starting" || login?.state === "waiting";
  }

  function controls() {
    refresh.disabled = busy;
    for (const button of list.querySelectorAll<HTMLButtonElement>("button")) button.disabled = busy;
  }

  function paint() {
    if (!dialog.isConnected) return;
    for (const agent of ["claude", "codex"] as const) {
      const account = accounts.find((entry) => entry.agent === agent);
      if (!account) continue;
      const name = agent === "claude" ? "Claude" : "Codex";
      let row = list.querySelector<HTMLElement>(`[data-agent="${agent}"]`);
      if (!row) {
        row = document.createElement("div");
        row.dataset.agent = agent;
        row.className = "flex min-w-0 flex-col gap-3";
        renderMarkup(
          row,
          `<h3>${name}</h3><p data-agent-status role="status" aria-live="polite"></p><div data-agent-actions class="row"></div><div data-agent-authorization class="flex min-w-0 flex-col gap-2"></div><pre data-agent-terminal class="max-h-64 overflow-auto whitespace-pre-wrap break-words" tabindex="0" aria-label="${name} sign-in terminal" hidden></pre><form data-agent-input hidden><label class="field"><span>Reply to ${name}</span><input name="text" autocomplete="off" spellcheck="false" maxlength="4096"></label><button class="btn" type="submit">Send reply</button></form>`,
        );
        list.append(row);
      }
      const login = account.session;
      const active = pending(login);
      row.querySelector<HTMLElement>("[data-agent-status]")!.textContent = active
        ? login?.state === "starting"
          ? "Starting sign-in…"
          : `Waiting for your sign-in. Expires at ${new Date(login!.expiresAt).toLocaleTimeString()}.`
        : account.connected
          ? "Connected to your account"
          : login?.state === "expired"
            ? "Sign-in expired. Start again to connect."
            : login?.state === "failed"
              ? "Sign-in failed. Start again to try another sign-in."
              : login?.state === "cancelled"
                ? "Sign-in cancelled"
                : "Not connected";
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
      if (terminal.textContent !== output) terminal.textContent = output;
      terminal.hidden = !output;
      row.querySelector<HTMLElement>("[data-agent-input]")!.hidden = !active || agent !== "claude";
      const authorization = row.querySelector<HTMLElement>("[data-agent-authorization]")!;
      const challenge = active ? login?.authorization : null;
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
    const result = await response.json().catch(() => null);
    if (!response.ok || !result)
      throw new Error(
        result?.error ?? "Agent accounts could not be reached. Refresh to try again.",
      );
    return result as T;
  }

  function accountPath(agent?: Agent, login?: Login): string {
    return `/api/runners/${encodeURIComponent(runner.id)}/accounts${agent ? `/${agent}/login${login ? `/${encodeURIComponent(login.id)}` : ""}` : ""}`;
  }

  function schedule() {
    window.clearTimeout(timer);
    if (!dialog.isConnected) return;
    if (accounts.some((account) => pending(account.session)))
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
      const result = await request<{ accounts: Account[] }>(accountPath());
      if (!dialog.isConnected || current !== generation) return;
      accounts = result.accounts;
      paint();
    } catch (error) {
      feedback.textContent = error instanceof Error ? error.message : "Refresh to try again.";
    } finally {
      busy = false;
      controls();
      schedule();
    }
  }

  async function act(agent: Agent, action: "start" | "cancel" | "input", input?: unknown) {
    if (busy || !dialog.isConnected) return;
    const account = accounts.find((entry) => entry.agent === agent);
    if (!account || (action !== "start" && !pending(account.session))) return;
    busy = true;
    controls();
    feedback.textContent = "";
    try {
      const login = await request<Login>(
        accountPath(agent, action === "start" ? undefined : account.session!) +
          (action === "input" ? "/input" : ""),
        action === "cancel" ? "DELETE" : "POST",
        action === "input" ? input : action === "start" ? {} : undefined,
      );
      account.session = login;
      account.connected = login.state === "connected";
      paint();
    } catch (error) {
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
    const agent = target?.closest<HTMLElement>("[data-agent]")?.dataset.agent as Agent | undefined;
    if (!target || !agent) return;
    if (target.hasAttribute("data-agent-open")) {
      if (busy) event.preventDefault();
      else if (agent === "codex") void act(agent, "input", { accept: true });
    } else void act(agent, target.dataset.agentAction as "start" | "cancel");
  });
  dialog.addEventListener("submit", (event) => {
    const form = event.target as HTMLFormElement;
    if (!form.matches("[data-agent-input]")) return;
    event.preventDefault();
    const agent = form.closest<HTMLElement>("[data-agent]")!.dataset.agent as Agent;
    const input = form.querySelector<HTMLInputElement>("input")!;
    const text = input.value;
    if (busy) return;
    input.value = "";
    void act(agent, "input", { text: `${text}\r` });
  });
  dialog.showModal();
  void load();
}

function providerUrl(value: string, agent: Agent): string {
  const url = new URL(value);
  const hosts =
    agent === "codex"
      ? ["auth.openai.com", "chatgpt.com"]
      : ["claude.ai", "console.anthropic.com", "platform.claude.com"];
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
