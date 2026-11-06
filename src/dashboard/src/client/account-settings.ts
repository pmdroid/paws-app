import { journalCaught } from "../journal";
import { readCsrfToken } from "./csrf";
import { esc } from "./format";
import { routeHref } from "./route";
import { renderMarkup } from "./theme";

export type AccountAgent = "claude" | "codex" | "grok" | "opencode";
export type ReadinessState =
  | "eligible"
  | "waiting"
  | "auth-required"
  | "cooling-down"
  | "unavailable";
export type Readiness = {
  state: ReadinessState;
  reason: string | null;
  detail: string;
  until: number | null;
  resetUnknown: boolean;
  low: boolean;
};
export type AccountBinding = {
  id: string;
  runnerId: string;
  runnerName: string;
  ownedByYou: boolean;
  legacy: boolean;
  quotaScope: "account" | "unknown";
  readiness: Readiness;
};
export type AgentAccount = {
  id: string;
  agent: AccountAgent;
  label: string;
  legacy: boolean;
  enabled: boolean;
  concurrency: number | null;
  running: number;
  sharedLimit: boolean;
  bindings: AccountBinding[];
};
export type AgentAccounts = {
  revision: string;
  canManage: boolean;
  agents: { agent: AccountAgent; name: string; unsupported: string | null }[];
  runners: { id: string; name: string; ownedByYou: boolean }[];
  accounts: AgentAccount[];
};
export type PreviewRole = "implementer" | "reviewer" | "reviewerFallback";
export type AccountPreview = {
  role: PreviewRole;
  repository: string | null;
  agent: AccountAgent;
  model: string | null;
  policyRevision: string | null;
  source: "project" | "defaults" | "default";
  accounts: {
    id: string;
    label: string;
    position: number;
    skipped: string | null;
    sharedLimit: boolean;
    bindings: AccountBinding[];
  }[];
  choice: {
    accountId: string;
    label: string;
    bindingId: string;
    runnerId: string;
    runnerName: string;
    position: number;
    fallback: string | null;
  } | null;
  waiting: string | null;
};

export type AccountSettingsView = {
  data: AgentAccounts | null;
  busy: string | null;
  error: string | null;
  notice: string | null;
  confirmRemove: string | null;
  preview: AccountPreview | null;
  previewRole: PreviewRole;
  previewRepository: string;
  previewError: string | null;
};

export function emptyAccountSettingsView(): AccountSettingsView {
  return {
    data: null,
    busy: null,
    error: null,
    notice: null,
    confirmRemove: null,
    preview: null,
    previewRole: "implementer",
    previewRepository: "",
    previewError: null,
  };
}

const READINESS: Record<ReadinessState, [string, string]> = {
  eligible: ["ok", "Eligible"],
  waiting: ["running", "Waiting"],
  "auth-required": ["bad", "Sign-in needed"],
  "cooling-down": ["warn", "Cooling down"],
  unavailable: ["", "Unavailable"],
};
const ROLES: Record<PreviewRole, string> = {
  implementer: "Implementer",
  reviewer: "Reviewer",
  reviewerFallback: "Reviewer fallback",
};

function when(at: number): string {
  return new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export function readinessMarkup(readiness: Readiness): string {
  const [tone, label] = READINESS[readiness.state];
  const next = readiness.resetUnknown
    ? "Reset unknown. Paws rechecks with a bounded backoff."
    : readiness.until !== null
      ? `Next check ${when(readiness.until)}.`
      : "";
  return `<span class="tag ${tone}">${label}</span> <span>${esc(readiness.detail)}</span>${next ? ` <span class="muted">${esc(next)}</span>` : ""}`;
}

function bindingMarkup(account: AgentAccount, binding: AccountBinding, canManage: boolean): string {
  const signIn = binding.ownedByYou
    ? ` <a href="${routeHref({ view: "runners", id: binding.runnerId })}">Sign in on ${esc(binding.runnerName)}</a>`
    : "";
  const unlink =
    !account.legacy && (canManage || binding.ownedByYou)
      ? ` <button class="btn" type="button" data-account-action="unlink" data-account="${esc(account.id)}" data-binding="${esc(binding.id)}">Unlink</button>`
      : "";
  return `<li class="flex min-w-0 flex-col gap-1" data-binding-row="${esc(binding.id)}"><b>${esc(binding.runnerName)}</b><p class="break-words">${readinessMarkup(binding.readiness)}</p><p>${signIn}${unlink}</p></li>`;
}

function accountMarkup(
  view: AccountSettingsView,
  account: AgentAccount,
  data: AgentAccounts,
): string {
  const manage = data.canManage && !account.legacy;
  const tags = [
    account.legacy ? '<span class="tag">Default sign-in</span>' : "",
    account.enabled ? "" : '<span class="tag warn">Disabled</span>',
  ].join(" ");
  const shared = account.sharedLimit
    ? `<p class="muted">These ${account.bindings.length} runners sign in to the same account, so they share one usage limit and ${account.concurrency === null ? "its concurrency" : `${account.concurrency} concurrent tasks`}. Linking more runners adds no quota.</p>`
    : "";
  const legacyNote = account.legacy
    ? '<p class="muted">Each runner\'s own sign-in. Paws cannot tell whether two runners use the same provider account, so it never treats them as separate quota.</p>'
    : "";
  const usage = `<p class="muted">${account.running} running${account.concurrency === null ? "" : ` of at most ${account.concurrency}`}.</p>`;
  const linked = new Set(account.bindings.map((binding) => binding.runnerId));
  const linkable = account.legacy
    ? []
    : data.runners.filter(
        (runner) => !linked.has(runner.id) && (data.canManage || runner.ownedByYou),
      );
  const link = linkable.length
    ? `<div class="row"><label class="sr-only" for="link-${esc(account.id)}">Runner for ${esc(account.label)}</label><select id="link-${esc(account.id)}" name="link-${esc(account.id)}">${linkable.map((runner) => `<option value="${esc(runner.id)}">${esc(runner.name)}</option>`).join("")}</select><button class="btn" type="button" data-account-action="link" data-account="${esc(account.id)}">Link runner</button></div>`
    : "";
  const confirming = view.confirmRemove === account.id;
  const controls = manage
    ? `<div class="flex min-w-0 flex-col gap-2"><div class="row"><label class="sr-only" for="label-${esc(account.id)}">Name for ${esc(account.label)}</label><input id="label-${esc(account.id)}" name="label-${esc(account.id)}" maxlength="80" value="${esc(account.label)}" autocomplete="off" spellcheck="false"><button class="btn" type="button" data-account-action="rename" data-account="${esc(account.id)}">Rename</button></div><div class="row"><label for="concurrency-${esc(account.id)}">Most tasks at once</label><input id="concurrency-${esc(account.id)}" name="concurrency-${esc(account.id)}" type="number" inputmode="numeric" min="1" max="64" step="1" placeholder="No limit" value="${account.concurrency ?? ""}"><button class="btn" type="button" data-account-action="concurrency" data-account="${esc(account.id)}">Save limit</button></div><div class="row"><button class="btn" type="button" data-account-action="${account.enabled ? "disable" : "enable"}" data-account="${esc(account.id)}">${account.enabled ? "Disable" : "Enable"}</button>${
        confirming
          ? `<span role="alert">Remove ${esc(account.label)} and unlink its runners? Running work keeps its account.</span><button class="btn" type="button" data-account-action="remove" data-account="${esc(account.id)}">Remove account</button><button class="btn" type="button" data-account-action="keep">Keep</button>`
          : `<button class="btn" type="button" data-account-action="confirm-remove" data-account="${esc(account.id)}">Remove…</button>`
      }</div></div>`
    : "";
  return `<li class="settings-project" data-account-row="${esc(account.id)}"><h4 class="break-words">${esc(account.label)} ${tags}</h4>${legacyNote}${usage}${shared}${
    account.bindings.length
      ? `<ul class="flex min-w-0 flex-col gap-3" role="list" aria-label="Runners for ${esc(account.label)}">${account.bindings.map((binding) => bindingMarkup(account, binding, data.canManage)).join("")}</ul>`
      : '<p class="muted">No runner is linked. Link a runner, then its owner signs in from Runners.</p>'
  }${
    link || controls
      ? `<details class="flex min-w-0 flex-col gap-2"${confirming ? " open" : ""}><summary>Manage ${esc(account.label)}</summary>${link}${controls}</details>`
      : ""
  }</li>`;
}

export function previewMarkup(view: AccountSettingsView): string {
  const preview = view.preview;
  const form = `<div class="row"><label for="account-preview-role">Role</label><select id="account-preview-role" name="account-preview-role">${Object.entries(
    ROLES,
  )
    .map(
      ([id, name]) =>
        `<option value="${id}" ${id === view.previewRole ? "selected" : ""}>${name}</option>`,
    )
    .join(
      "",
    )}</select><label for="account-preview-repository">Repository</label><input id="account-preview-repository" name="account-preview-repository" placeholder="owner/repository" autocapitalize="none" spellcheck="false" value="${esc(view.previewRepository)}"><button class="btn" type="button" data-account-action="preview">Preview</button></div><p class="sub">The preview reads saved state only. It starts no work, reserves nothing and asks no provider. Who may use each runner is checked when work is placed.</p>`;
  if (view.previewError)
    return `${form}<p class="settings-message err" role="alert">${esc(view.previewError)}</p>`;
  if (!preview) return form;
  const order =
    preview.source === "default"
      ? "No account order: new work runs as the runner's default sign-in."
      : `Order from ${preview.source === "project" ? "the project override" : "the global defaults"}, revision ${preview.policyRevision ?? "unknown"}.`;
  const outcome = preview.choice
    ? `<p role="status">New ${esc(ROLES[preview.role].toLowerCase())} work would run as <b>${esc(preview.choice.label)}</b> (#${preview.choice.position}) on ${esc(preview.choice.runnerName)}.</p>${preview.choice.fallback ? `<p>Fallback because ${esc(preview.choice.fallback)}.</p>` : ""}`
    : `<p role="status" class="err">${esc(preview.waiting ?? "New work would wait.")}</p>`;
  const rows = preview.accounts
    .map(
      (account) =>
        `<li class="flex min-w-0 flex-col gap-1"><b>${account.position}. ${esc(account.label)}</b>${
          account.skipped
            ? `<p><span class="tag">Skipped</span> ${esc(account.skipped)}</p>`
            : account.bindings.length
              ? `<ul class="flex min-w-0 flex-col gap-1" role="list">${account.bindings.map((binding) => `<li class="break-words">${esc(binding.runnerName)}: ${readinessMarkup(binding.readiness)}</li>`).join("")}</ul>`
              : '<p class="muted">No runner is linked.</p>'
        }${account.sharedLimit ? '<p class="muted">One shared limit across its runners.</p>' : ""}</li>`,
    )
    .join("");
  return `${form}<div class="flex min-w-0 flex-col gap-2" aria-live="polite"><p class="sub">${esc(order)}</p>${outcome}<ol class="flex min-w-0 flex-col gap-3">${rows}</ol></div>`;
}

export function renderAccountSettings(view: AccountSettingsView): string {
  const intro =
    '<div class="settings-label"><h2>Agent accounts</h2><p class="sub">Named provider accounts, each signed in on the runners linked to it. Credentials stay on the runner: a runner\'s owner signs in from Runners with the agent\'s own sign-in. Set the order each role tries below.</p></div>';
  const message = view.error
    ? `<p class="settings-message err" role="alert">${esc(view.error)}</p>`
    : view.notice
      ? `<p class="settings-message" role="status">${esc(view.notice)}</p>`
      : "";
  if (!view.data)
    return `<section class="settings-section">${intro}<div class="col">${message || `<p class="settings-message" role="status">${esc(view.busy ?? "Loading agent accounts…")}</p>`}<button class="btn" type="button" data-account-action="reload">Try again</button></div></section>`;
  const data = view.data;
  const groups = data.agents
    .map((agent) => {
      const accounts = data.accounts.filter((account) => account.agent === agent.agent);
      const unsupported = agent.unsupported
        ? `<p class="settings-message err">Named ${esc(agent.name)} accounts are not supported: ${esc(agent.unsupported)}. Work runs as the default sign-in only.</p>`
        : "";
      if (!accounts.length && !unsupported) return "";
      return `<section class="flex min-w-0 flex-col gap-3" data-account-agent="${agent.agent}"><h3>${esc(agent.name)}</h3>${unsupported}<ul class="flex min-w-0 flex-col gap-4" role="list">${accounts.map((account) => accountMarkup(view, account, data)).join("")}</ul></section>`;
    })
    .join("");
  const supported = data.agents.filter((agent) => agent.unsupported === null);
  const create = data.canManage
    ? `<form id="account-create" class="flex min-w-0 flex-col gap-2"><h3>Add an account</h3><div class="row"><label for="account-agent">Agent</label><select id="account-agent" name="account-agent">${supported.map((agent) => `<option value="${agent.agent}">${esc(agent.name)}</option>`).join("")}</select><label for="account-label">Name</label><input id="account-label" name="account-label" maxlength="80" required autocomplete="off" spellcheck="false" placeholder="Team Claude"><button class="btn primary" type="submit">Add account</button></div><p class="sub">Use a name, not an email address or key. Then link runners and sign in on each.</p></form>`
    : '<p class="sub">A workspace admin adds accounts. You can link and sign in on your own runners.</p>';
  return `<section class="settings-section">${intro}<fieldset class="col" ${view.busy ? "disabled" : ""}>${message}${groups}${create}<section class="flex min-w-0 flex-col gap-2"><h3>Which account would new work use?</h3>${previewMarkup(view)}</section><div class="settings-actions"><button class="btn" type="button" data-account-action="reload">Refresh accounts</button></div></fieldset>${view.busy ? `<p class="settings-message" role="status">${esc(view.busy)}</p>` : ""}</section>`;
}

export async function accountRequest<T>(
  engine: string,
  path: string,
  body?: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const response = await fetchImpl(new URL(path, engine), {
    method: body === undefined ? "GET" : "POST",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...(body === undefined
        ? {}
        : { "Content-Type": "application/json", "x-paws-csrf": readCsrfToken(document) }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await response.json().catch((caught) => {
    journalCaught(caught, "account-settings.request.json", null);
    return null;
  })) as { error?: string } | null;
  if (!response.ok)
    throw new Error(data?.error ?? `Agent accounts request failed (${response.status}).`, {
      cause: response.status,
    });
  return data as T;
}

export function createAccountSettings(onChange: () => void = () => {}): {
  mount(root: HTMLElement, engine: string | null): void;
} {
  let root: HTMLElement | null = null;
  let engine: string | null = null;
  let generation = 0;
  let view = emptyAccountSettingsView();
  const paint = () => {
    if (!root) return;
    const active = document.activeElement;
    const held =
      active instanceof HTMLElement && root.contains(active) && active.id ? active.id : "";
    const repository = root.querySelector<HTMLInputElement>("#account-preview-repository");
    if (repository) view.previewRepository = repository.value;
    renderMarkup(root, renderAccountSettings(view));
    if (held)
      root.querySelector<HTMLElement>(`#${CSS.escape(held)}`)?.focus({ preventScroll: true });
  };
  const run = async (busy: string, operation: (started: number) => Promise<void>) => {
    if (!engine || view.busy) return;
    const started = ++generation;
    view.busy = busy;
    view.error = null;
    view.notice = null;
    paint();
    try {
      await operation(started);
    } catch (error) {
      journalCaught(error, "account-settings.run", null);
      if (started !== generation) return;
      if (error instanceof Error && error.cause === 409) {
        view.error = error.message;
        view.confirmRemove = null;
        view.busy = null;
        await load(true);
        return;
      }
      view.error = error instanceof Error ? error.message : "Agent accounts could not be changed.";
    }
    if (started !== generation) return;
    view.busy = null;
    paint();
  };
  const load = (keepError = false) => {
    const error = view.error;
    return run("Loading agent accounts…", async (started) => {
      const data = await accountRequest<AgentAccounts>(engine!, "/api/runners/accounts");
      if (started !== generation) return;
      view.data = data;
      if (keepError) view.error = error;
    });
  };
  const write = (path: string, body: Record<string, unknown>, notice: string) =>
    run("Saving…", async (started) => {
      if (!view.data) return;
      const data = await accountRequest<AgentAccounts>(engine!, path, {
        ...body,
        revision: view.data.revision,
      });
      if (started !== generation) return;
      view.data = data;
      view.notice = notice;
      view.confirmRemove = null;
      onChange();
    });
  const preview = () =>
    run("Checking eligibility…", async (started) => {
      const params = new URLSearchParams({ role: view.previewRole });
      if (view.previewRepository.trim()) params.set("repository", view.previewRepository.trim());
      try {
        const result = await accountRequest<AccountPreview>(
          engine!,
          `/api/runners/accounts/preview?${params}`,
        );
        if (started !== generation) return;
        view.preview = result;
        view.previewError = null;
      } catch (error) {
        if (started !== generation) return;
        view.preview = null;
        view.previewError = error instanceof Error ? error.message : "The preview failed.";
      }
    });
  const click = (event: Event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-account-action]");
    if (!button || view.busy || !root) return;
    const action = button.dataset.accountAction;
    const id = button.dataset.account ?? "";
    const path = `/api/runners/accounts/${encodeURIComponent(id)}`;
    const field = (name: string) =>
      root!.querySelector<HTMLInputElement | HTMLSelectElement>(
        `[name="${name}-${CSS.escape(id)}"]`,
      )?.value ?? "";
    if (action === "reload") void load();
    else if (action === "preview") {
      paint();
      void preview();
    } else if (action === "confirm-remove") {
      view.confirmRemove = id;
      paint();
    } else if (action === "keep") {
      view.confirmRemove = null;
      paint();
    } else if (action === "remove") void write(`${path}/remove`, {}, "Account removed.");
    else if (action === "enable" || action === "disable")
      void write(
        path,
        { enabled: action === "enable" },
        action === "enable"
          ? "Account enabled. New work may use it."
          : "Account disabled. Running work keeps it; new work skips it.",
      );
    else if (action === "rename") void write(path, { label: field("label") }, "Account renamed.");
    else if (action === "concurrency") {
      const value = field("concurrency").trim();
      void write(
        path,
        { concurrency: value === "" ? null : Number(value) },
        "Concurrency limit saved.",
      );
    } else if (action === "link")
      void write(
        `${path}/bindings`,
        { runnerId: field("link") },
        "Runner linked. Sign in on it to use it.",
      );
    else if (action === "unlink")
      void write(
        `${path}/bindings/${encodeURIComponent(button.dataset.binding ?? "")}/remove`,
        {},
        "Runner unlinked. Running work keeps its account.",
      );
  };
  const submit = (event: Event) => {
    const form = (event.target as Element).closest<HTMLFormElement>("#account-create");
    if (!form) return;
    event.preventDefault();
    if (view.busy) return;
    const agent = form.querySelector<HTMLSelectElement>('[name="account-agent"]')?.value;
    const label = form.querySelector<HTMLInputElement>('[name="account-label"]')?.value ?? "";
    void write(
      "/api/runners/accounts",
      { agent, label },
      "Account added. Link a runner to sign in.",
    );
  };
  const change = (event: Event) => {
    const target = event.target as HTMLSelectElement;
    if (target.name === "account-preview-role") view.previewRole = target.value as PreviewRole;
  };
  return {
    mount(next, nextEngine) {
      if (root === next && engine === nextEngine) return;
      root?.removeEventListener("click", click);
      root?.removeEventListener("submit", submit);
      root?.removeEventListener("change", change);
      if (engine !== nextEngine) {
        generation += 1;
        view = emptyAccountSettingsView();
      }
      root = next;
      engine = nextEngine;
      root.addEventListener("click", click);
      root.addEventListener("submit", submit);
      root.addEventListener("change", change);
      if (!engine) {
        view.error = "Connect to your Paws dashboard to manage agent accounts.";
        paint();
      } else if (!view.data && !view.busy) void load();
      else paint();
    },
  };
}
