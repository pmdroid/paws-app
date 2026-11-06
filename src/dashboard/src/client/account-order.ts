import { journalCaught } from "../journal";
import type { AccountLists, AgentProfile, AgentRole, AgentSettings } from "../agent-settings";
import type { AgentAccounts } from "./account-settings";
import { settingsRequest } from "./agent-settings";
import { readCsrfToken } from "./csrf";
import { esc } from "./format";
import { routeHref } from "./route";
import { renderMarkup } from "./theme";

const ROLES: AgentRole[] = ["implementer", "reviewer"];
const MAX_ACCOUNTS = 8;
const NO_ORDER = "No order: new work runs as the default sign-in on each runner.";

export type AccountChoice = Pick<
  AgentAccounts["accounts"][number],
  "id" | "agent" | "label" | "legacy" | "enabled"
>;
type AccountRole = keyof AccountLists;

export function accountList(
  settings: AgentSettings,
  scope: string,
  role: AccountRole,
): string[] | undefined {
  if (scope === "defaults") return settings.defaults.accounts?.[role];
  if (role === "reviewerFallback") return undefined;
  return settings.projects[Number(scope)]?.accounts?.[role];
}

export function setAccountList(
  settings: AgentSettings,
  scope: string,
  role: AccountRole,
  ids: string[],
): void {
  if (scope === "defaults") {
    const lists = { ...settings.defaults.accounts, [role]: ids };
    if (!ids.length) delete lists[role];
    if (Object.keys(lists).length) settings.defaults.accounts = lists;
    else delete settings.defaults.accounts;
    return;
  }
  const project = settings.projects[Number(scope)];
  if (!project || role === "reviewerFallback") return;
  const lists = { ...project.accounts, [role]: ids };
  if (!ids.length) delete lists[role];
  if (Object.keys(lists).length) project.accounts = lists;
  else delete project.accounts;
}

export function moveAccount(ids: readonly string[], index: number, by: -1 | 1): string[] {
  const next = [...ids];
  const target = index + by;
  if (index < 0 || index >= next.length || target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

export function accountOrderMarkup(
  key: string,
  scope: string,
  role: AccountRole,
  agent: AgentProfile["agent"],
  ids: readonly string[],
  accounts: readonly AccountChoice[] | undefined,
  inherits: string,
): string {
  const label = (id: string) => {
    const account = accounts?.find((entry) => entry.id === id);
    if (!account) return `${esc(id)} <span class="tag bad">Unknown or removed</span>`;
    return `${esc(account.label)}${account.agent !== agent ? ' <span class="tag bad">Another agent</span>' : ""}${account.enabled ? "" : ' <span class="tag warn">Disabled, skipped</span>'}`;
  };
  const button = (action: string, index: number, text: string, name: string, off: boolean) =>
    `<button class="btn" type="button" data-order="${action}" data-scope="${scope}" data-role="${role}" data-index="${index}" aria-label="${esc(name)}" ${off ? "disabled" : ""}>${text}</button>`;
  const rows = ids
    .map((id, index) => {
      const name = accounts?.find((entry) => entry.id === id)?.label ?? id;
      return `<li class="row"><span class="break-words">${index + 1}. ${label(id)}</span>${button("account-up", index, "Up", `Move ${name} up`, index === 0)}${button("account-down", index, "Down", `Move ${name} down`, index === ids.length - 1)}${button("account-remove", index, "Remove", `Remove ${name} from the order`, false)}</li>`;
    })
    .join("");
  const choices = (accounts ?? []).filter(
    (account) => account.agent === agent && !ids.includes(account.id),
  );
  const add =
    accounts && ids.length < MAX_ACCOUNTS && choices.length
      ? `<div class="row"><label class="sr-only" for="${key}-account-add">Add an account to the ${esc(role)} order</label><select id="${key}-account-add" name="${key}-account-add">${choices.map((account) => `<option value="${esc(account.id)}">${esc(account.label)}${account.enabled ? "" : " (disabled)"}</option>`).join("")}</select><button class="btn" type="button" data-order="account-add" data-scope="${scope}" data-role="${role}">Add to order</button></div>`
      : "";
  return `<div class="settings-field" data-account-order="${key}"><span>Account order</span>${ids.length ? `<ol class="flex min-w-0 flex-col gap-2">${rows}</ol>` : `<p class="sub">${esc(inherits)}</p>`}${add}${ids.length ? '<p class="sub">New work tries these in order and falls back when one cannot run. Work already running keeps its account.</p>' : ""}</div>`;
}

type OrderView = {
  data: AgentSettings | null;
  accounts?: AccountChoice[];
  busy: string | null;
  error: string | null;
  saved: boolean;
  denied?: boolean;
};

function roleOrder(title: string, order: string): string {
  return `<div class="settings-profile"><div class="settings-role"><h4>${title}</h4></div>${order}</div>`;
}

export function renderAccountOrder(view: OrderView): string {
  const intro = `<div class="settings-label"><h3>Account order</h3><p class="sub">The accounts each role tries for new work. Choose each role's agent, model and effort in <a href="${routeHref({ view: "settings", page: "agents" })}">Settings › Agents</a>.</p></div>`;
  if (view.denied)
    return `<section class="settings-section">${intro}<p class="sub">Only workspace admins can change the account order.</p></section>`;
  if (!view.data)
    return `<section class="settings-section">${intro}<div class="col"><p class="settings-message${view.error ? " err" : ""}" role="${view.error ? "alert" : "status"}">${esc(view.error ?? "Loading account order…")}</p>${view.error ? '<button class="btn" type="button" data-order="reload">Try again</button>' : ""}</div></section>`;
  const data = view.data;
  const defaults = ROLES.map((role) =>
    roleOrder(
      role === "implementer" ? "Implementer" : "Reviewer",
      accountOrderMarkup(
        `defaults-${role}`,
        "defaults",
        role,
        data.defaults[role].agent,
        data.defaults.accounts?.[role] ?? [],
        view.accounts,
        NO_ORDER,
      ),
    ),
  ).join("");
  const fallback = data.defaults.reviewerFallback
    ? roleOrder(
        "Reviewer fallback",
        accountOrderMarkup(
          "defaults-reviewerFallback",
          "defaults",
          "reviewerFallback",
          data.defaults.reviewerFallback.agent,
          data.defaults.accounts?.reviewerFallback ?? [],
          view.accounts,
          "No order: the fallback reviewer runs as the default sign-in.",
        ),
      )
    : "";
  const projects = data.projects
    .map(
      (project, index) =>
        `<section class="settings-project"><h4>${esc(project.repo)}</h4><div class="settings-roles">${ROLES.map(
          (role) => {
            const profile = project[role] ?? data.defaults[role];
            const inherits =
              profile.agent === data.defaults[role].agent && data.defaults.accounts?.[role]
                ? "Uses the global order."
                : NO_ORDER;
            return roleOrder(
              role === "implementer" ? "Implementer" : "Reviewer",
              accountOrderMarkup(
                `${index}-${role}`,
                String(index),
                role,
                profile.agent,
                project.accounts?.[role] ?? [],
                view.accounts,
                inherits,
              ),
            );
          },
        ).join("")}</div></section>`,
    )
    .join("");
  const feedback = view.error
    ? `<p class="settings-message err" role="alert">${esc(view.error)}</p>`
    : view.saved
      ? '<p class="settings-message" role="status">Account order saved. New work uses it.</p>'
      : "";
  return `<section class="settings-section">${intro}<fieldset class="col" ${view.busy ? "disabled" : ""}>${feedback}<div class="settings-roles">${defaults}${fallback}</div>${projects}<div class="settings-actions"><button class="btn primary" type="button" data-order="save">Save order</button><button class="btn" type="button" data-order="reload">Discard changes</button></div></fieldset>${view.busy ? `<p class="settings-message" role="status">${esc(view.busy)}</p>` : ""}</section>`;
}

export function createAccountOrder(onSaved: () => void = () => {}): {
  mount(root: HTMLElement, engine: string | null): void;
  accountsChanged(): void;
  stale(): void;
} {
  let root: HTMLElement | null = null;
  let engine: string | null = null;
  let generation = 0;
  let view: OrderView = { data: null, busy: null, error: null, saved: false };
  const paint = () => {
    if (root) renderMarkup(root, renderAccountOrder(view));
  };
  const request = async (busy: string, operation: (started: number) => Promise<void>) => {
    const started = ++generation;
    view.busy = busy;
    view.error = null;
    paint();
    try {
      await operation(started);
    } catch (error) {
      journalCaught(error, "account-order.request", null);
      if (started !== generation) return;
      view.error = error instanceof Error ? error.message : "Could not update the account order.";
    }
    if (started !== generation) return;
    view.busy = null;
    paint();
  };
  const load = () =>
    request("Loading account order…", async (started) => {
      try {
        const data = await settingsRequest<AgentSettings>(engine!, "GET");
        if (started !== generation) return;
        view.data = data;
        view.denied = false;
        view.saved = false;
      } catch (error) {
        if (error instanceof Error && error.cause === 403) {
          view.denied = true;
          view.data = null;
          return;
        }
        throw error;
      }
    });
  const loadAccounts = async () => {
    if (!engine) return;
    try {
      const response = await fetch(new URL("/api/runners/accounts", engine), {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error("Agent accounts could not be loaded.");
      const data = (await response.json()) as AgentAccounts;
      view.accounts = data.accounts.map(({ id, agent, label, legacy, enabled }) => ({
        id,
        agent,
        label,
        legacy,
        enabled,
      }));
    } catch (error) {
      journalCaught(error, "account-order.accounts", null);
      return;
    }
    if (!view.busy) paint();
  };
  const save = () =>
    request("Saving account order…", async (started) => {
      const data = await settingsRequest<
        AgentSettings & { waitingRuns?: number; warnings?: string[] }
      >(engine!, "PUT", { ...view.data, applyToWaiting: false }, readCsrfToken(document));
      if (started !== generation) return;
      const { waitingRuns: _waiting, warnings: _warnings, ...settings } = data;
      view.data = settings;
      view.saved = true;
      onSaved();
    });
  const click = (event: Event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-order]");
    if (!button || view.busy || !engine) return;
    const action = button.dataset.order;
    if (action === "reload") return void load();
    if (action === "save") return void save();
    if (!view.data) return;
    const scope = button.dataset.scope ?? "";
    const role = button.dataset.role as AccountRole;
    const index = Number(button.dataset.index);
    const ids = accountList(view.data, scope, role) ?? [];
    const key = `${scope}-${role}`;
    const next =
      action === "account-up"
        ? moveAccount(ids, index, -1)
        : action === "account-down"
          ? moveAccount(ids, index, 1)
          : action === "account-remove"
            ? ids.filter((_, position) => position !== index)
            : [
                ...ids,
                root?.querySelector<HTMLSelectElement>(`[name="${key}-account-add"]`)?.value ?? "",
              ].filter(Boolean);
    setAccountList(view.data, scope, role, next);
    view.saved = false;
    view.error = null;
    paint();
    root
      ?.querySelector<HTMLElement>(
        `[data-account-order="${key}"] button:not(:disabled), [data-account-order="${key}"] select`,
      )
      ?.focus();
  };
  return {
    accountsChanged() {
      void loadAccounts();
    },
    stale() {
      if (!view.busy) view.data = null;
    },
    mount(next, nextEngine) {
      if (root === next && engine === nextEngine) return;
      root?.removeEventListener("click", click);
      if (engine !== nextEngine) {
        generation += 1;
        view = { data: null, busy: null, error: null, saved: false };
      }
      root = next;
      engine = nextEngine;
      root.addEventListener("click", click);
      if (!engine) {
        view.error = "Connect to your Paws dashboard to change the account order.";
        paint();
        return;
      }
      if (!view.data && !view.busy && !view.denied) void load();
      else paint();
      void loadAccounts();
    },
  };
}
