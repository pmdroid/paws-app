import { journalCaught } from "../journal";
import { routeHref } from "./route";
import { renderMarkup } from "./theme";
import type {
  AgentModelCatalog,
  AgentPreset,
  AgentProfile,
  AgentRole,
  AgentSettings,
} from "../agent-settings";
import { esc } from "./format";
import { readCsrfToken } from "./csrf";

const ROLES: AgentRole[] = ["implementer", "reviewer"];
const AGENTS = { claude: "Claude Code", codex: "Codex", grok: "Grok", opencode: "OpenCode" };

const sameProfiles = ({ implementer, reviewer }: AgentPreset) =>
  implementer.agent === reviewer.agent && implementer.model === reviewer.model;

export function settingsProblems(settings: AgentSettings): string[] {
  return sameProfiles(settings.defaults)
    ? ["Global defaults: choose a different reviewer agent or model for independent review."]
    : [];
}

function presetProblem(row: PresetRow): string | null {
  return sameProfiles(row.preset)
    ? "Choose a different reviewer agent or model for independent review."
    : null;
}

function clearAccounts(settings: AgentSettings, role: string): void {
  const owner = settings.defaults;
  if (!owner.accounts) return;
  const lists: Record<string, unknown> = { ...owner.accounts };
  delete lists[role];
  if (Object.keys(lists).length) owner.accounts = lists as typeof owner.accounts;
  else delete owner.accounts;
}

export async function settingsRequest<T>(
  engine: string,
  method: "GET" | "PUT",
  body?: unknown,
  csrf = "",
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const response = await fetchImpl(new URL("/api/settings/agents", engine), {
    method,
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...(method === "GET" ? {} : { "Content-Type": "application/json", "x-paws-csrf": csrf }),
    },
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      typeof data.error === "string" ? data.error : `Request failed (${response.status}).`,
      { cause: response.status },
    );
  return data as T;
}

type PresetRow = { name: string; preset: AgentPreset };

type SettingsView = {
  presetRows?: PresetRow[];
  data: AgentSettings | null;
  busy: string | null;
  error: string | null;
  saved: boolean;
  applyToWaiting?: boolean;
  waitingRuns?: number;
  warnings?: string[];
  denied?: boolean;
  catalogs?: AgentModelCatalog[];
  catalogError?: string | null;
};

export function renderAgentSettings(view: SettingsView): string {
  if (view.denied) return '<p class="sub">Only workspace admins can change agent profiles.</p>';
  const intro = `<p class="sub">Agents run on an installed runner. Model and effort choices refresh automatically from your signed-in <a href="${routeHref({ view: "runners", id: null })}">Runners</a>.</p>`;
  if (!view.data)
    return `${intro}<div class="settings-message" role="${view.error ? "alert" : "status"}">${esc(view.error ?? "Loading agent settings…")}</div>${view.error ? '<button class="btn" type="button" data-settings="reload">Try again</button>' : ""}`;
  const problems = settingsProblems(view.data);
  const rows =
    view.presetRows ??
    Object.entries(view.data.presets ?? {}).map(([name, preset]) => ({ name, preset }));
  const blocked = problems.length > 0 || rows.some((row) => presetProblem(row));
  const feedback = view.error
    ? `<p class="settings-message err" role="alert">${esc(view.error)}</p>`
    : view.saved
      ? `<p class="settings-message" role="status">${view.waitingRuns === undefined ? "Agent settings saved. New work will use these profiles." : `Saved. ${view.waitingRuns} waiting ${view.waitingRuns === 1 ? "run will" : "runs will"} switch at their next step.`}</p>${view.warnings?.length ? `<p class="settings-message err" role="alert">${view.warnings.map(esc).join("<br>")} Closeout's review waits until a runner signs in to this agent.</p>` : ""}`
      : "";
  return `${intro}${view.catalogError ? `<p class="settings-message err" role="status">${esc(view.catalogError)} <button class="btn" type="button" data-settings="models">Reload choices</button></p>` : ""}<form id="agent-settings-form"><div id="settings-feedback">${feedback}</div>
    <fieldset class="settings-fields" ${view.busy ? "disabled" : ""}>
      <section class="settings-section"><div class="settings-label"><h2>Global defaults</h2><p class="sub">Used by every repository. The reviewer must use a different agent or model.</p></div><div class="settings-roles">${ROLES.map((role) => profileFields("defaults", role, view.data!.defaults[role], view.catalogs)).join("")}</div></section>
      <section class="settings-section"><div class="settings-label"><h2>Label presets</h2><p class="sub">Add a label with a preset's name to a Linear issue to run that issue with the preset's implementer and reviewer. A change applies from the issue's next run.</p></div><div class="col">
      ${rows
        .map((row, index) => {
          const key = `preset-${index}`;
          const error = presetError(view.error, row.name) ?? presetProblem(row);
          return `<section class="settings-project" data-preset-row="${index}"><div class="settings-field"><label for="${key}-name">Name</label><input id="${key}-name" name="${key}-name" value="${esc(row.name)}" autocapitalize="none" spellcheck="false" ${error ? `aria-invalid="true" aria-describedby="${key}-error"` : ""}></div>
        ${ROLES.map((role) => profileFields(key, role, row.preset[role], view.catalogs)).join("")}
        ${error ? `<p id="${key}-error" class="settings-message err" role="alert">${esc(error)}</p>` : ""}
        <button class="btn" type="button" data-settings="remove-preset" data-index="${index}">Remove preset</button></section>`;
        })
        .join("")}
      <button class="btn" type="button" data-settings="add-preset">Add preset</button></div></section>
      <div id="settings-problems" class="settings-message err" role="alert" ${problems.length ? "" : "hidden"}>${problems.map(esc).join("<br>")}</div>
      <label class="settings-inherit"><input type="checkbox" name="apply-to-waiting" ${view.applyToWaiting ? "checked" : ""} aria-describedby="apply-to-waiting-help">Also switch runs that are waiting</label>
      <p class="sub" id="apply-to-waiting-help">Waiting runs use these profiles at their next step. Agents working now finish with their current profiles.</p>
      <div class="settings-actions"><button class="btn primary" type="submit" ${blocked ? "disabled" : ""}>Save settings</button><button class="btn" type="button" data-settings="reload">Discard changes</button></div>
    </fieldset>${view.busy ? `<p class="settings-message" role="status">${esc(view.busy)}</p>` : ""}</form>`;
}

function profileFields(
  scope: string,
  role: AgentRole,
  profile: AgentProfile,
  catalogs: AgentModelCatalog[] = [],
): string {
  const key = `${scope}-${role}`;
  const label = role === "implementer" ? "Implementer" : "Reviewer";
  const catalog = catalogs.find((value) => value.agent === profile.agent);
  const selected = catalog?.models.find((model) => model.id === profile.model);
  const longContext =
    profile.agent === "claude" &&
    profile.model !== null &&
    (selected?.longContext ?? /\[1m\]$/i.test(profile.model));
  const efforts = profile.model === null ? catalog?.efforts : selected?.efforts;
  const choices = (
    field: "model" | "effort",
    value: string | null | undefined,
    options: { id: string; name: string }[] | null | undefined,
  ) => {
    const available = (options ?? []).filter(
      (option) => field !== "effort" || !["default", "auto"].includes(option.id),
    );
    if (value && !available.some((option) => option.id === value))
      available.unshift({ id: value, name: value });
    const hint = field === "model" && longContext ? ` aria-describedby="${key}-model-hint"` : "";
    return `<select id="${key}-${field}" name="${key}-${field}"${hint} ${options == null ? "disabled" : ""}><option value="" ${value ? "" : "selected"}>Agent default</option>${available.map((option) => `<option value="${esc(option.id)}" ${option.id === value ? "selected" : ""}>${esc(option.name)}</option>`).join("")}</select>`;
  };
  return `<div class="settings-profile"><div class="settings-role"><h3>${label}</h3></div>
    <div class="settings-controls"><div class="settings-field"><label for="${key}-agent">Agent</label><select id="${key}-agent" name="${key}-agent">${Object.entries(
      AGENTS,
    )
      .map(
        ([id, name]) =>
          `<option value="${id}" ${id === profile.agent ? "selected" : ""}>${name}</option>`,
      )
      .join("")}</select></div>
    <div class="settings-field"><label for="${key}-model">Model</label>${choices("model", profile.model, catalog?.models)}${longContext ? `<small class="sub" id="${key}-model-hint">1M context uses more of your Claude usage.</small>` : ""}${catalog ? "" : '<small class="sub">Sign in on a runner to load model choices.</small>'}</div>
    <div class="settings-field"><label for="${key}-effort">Effort</label>${choices("effort", profile.effort, efforts)}${catalog && efforts == null ? '<small class="sub" role="status">Loading effort choices…</small>' : ""}</div>${selected?.fast ? `<label class="settings-inherit"><input type="checkbox" id="${key}-fast" name="${key}-fast" ${profile.fast ? "checked" : ""}>Fast mode</label>` : profile.fast ? `<small class="sub">Fast mode isn't available for this model</small>` : ""}</div></div>`;
}

function presetError(error: string | null, name: string): string | null {
  if (!error) return null;
  if (error === `Duplicate preset: ${name}` || error.startsWith(`Preset ${name}: `)) return error;
  try {
    const issues = JSON.parse(error) as { path?: unknown[] }[];
    if (
      Array.isArray(issues) &&
      issues.some((issue) => issue.path?.[0] === "presets" && issue.path[1] === name)
    )
      return error;
  } catch {
    // Other settings errors stay in the form feedback.
    return null;
  }
  return null;
}

function profilesOnly(settings: AgentSettings): Omit<AgentSettings, "queue" | "merge"> {
  const { queue: _queue, merge: _merge, ...rest } = settings;
  return rest;
}

export function createAgentSettings(
  invalidate: () => void,
  onSaved: () => void = () => {},
): {
  mount(root: HTMLElement, engine: string | null): void;
  stale(): void;
} {
  let root: HTMLElement | null = null;
  let engine: string | null = null;
  let generation = 0;
  let catalogTimer: ReturnType<typeof setTimeout> | undefined;
  let view: SettingsView = {
    data: null,
    busy: null,
    error: null,
    saved: false,
  };
  const paint = () => {
    if (!root) return;
    let heldFocus: string | null = null;
    const active = document.activeElement;
    if (active instanceof HTMLElement && root.contains(active)) {
      heldFocus = active.id
        ? `#${CSS.escape(active.id)}`
        : active.getAttribute("name")
          ? `[name="${active.getAttribute("name")}"]`
          : active.dataset.profile
            ? `[data-profile="${active.dataset.profile}"]`
            : active.dataset.settings
              ? `[data-settings="${active.dataset.settings}"]`
              : null;
    }
    renderMarkup(root, renderAgentSettings(view));
    if (heldFocus) root.querySelector<HTMLElement>(heldFocus)?.focus({ preventScroll: true });
  };
  const draft = () => {
    if (!root || !view.data) return;
    const form = root.querySelector("form");
    if (!form) return;
    const read = (key: string, previous: AgentProfile): AgentProfile => {
      const effort = form.querySelector<HTMLSelectElement>(`[name="${key}-effort"]`)?.value.trim();
      const toggle = form.querySelector<HTMLInputElement>(`[name="${key}-fast"]`);
      const fast = toggle ? toggle.checked : previous.fast;
      return {
        agent: (form.querySelector<HTMLSelectElement>(`[name="${key}-agent"]`)?.value ??
          previous.agent) as AgentProfile["agent"],
        model: form.querySelector<HTMLSelectElement>(`[name="${key}-model"]`)?.value.trim() || null,
        ...(effort ? { effort } : {}),
        ...(fast ? { fast: true } : {}),
      };
    };
    for (const role of ROLES)
      view.data.defaults[role] = read(`defaults-${role}`, view.data.defaults[role]);
    view.presetRows?.forEach((row, index) => {
      row.name =
        form.querySelector<HTMLInputElement>(`[name="preset-${index}-name"]`)?.value ?? row.name;
      for (const role of ROLES)
        row.preset[role] = read(`preset-${index}-${role}`, row.preset[role]);
    });
    view.applyToWaiting =
      form.querySelector<HTMLInputElement>('[name="apply-to-waiting"]')?.checked ?? false;
    view.saved = false;
    view.error = null;
  };
  const loadCatalog = async () => {
    if (!engine || !root?.isConnected) return;
    const started = generation;
    const before = JSON.stringify({ catalogs: view.catalogs, error: view.catalogError });
    try {
      const response = await fetch(new URL("/api/runners/models", engine), {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        if ([401, 403].includes(response.status)) view.catalogs = [];
        throw new Error("Model choices could not be loaded.");
      }
      const data = (await response.json()) as { catalogs: AgentModelCatalog[] };
      if (started !== generation) return;
      view.catalogs = data.catalogs;
      view.catalogError = null;
    } catch (error) {
      journalCaught(error, "agent-settings.createAgentSettings.fetch", null);
      if (started !== generation) return;
      view.catalogError =
        error instanceof Error ? error.message : "Model choices could not be loaded.";
    }
    if (
      !view.busy &&
      before !== JSON.stringify({ catalogs: view.catalogs, error: view.catalogError })
    ) {
      const saved = view.saved,
        error = view.error;
      draft();
      view.saved = saved;
      view.error = error;
      paint();
    }
    clearTimeout(catalogTimer);
    catalogTimer = setTimeout(() => void loadCatalog(), 10_000);
  };
  const request = async (busy: string, operation: () => Promise<void>) => {
    const started = generation;
    view.busy = busy;
    view.error = null;
    try {
      paint();
      await operation();
    } catch (error) {
      journalCaught(error, "agent-settings.createAgentSettings.paint", null);
      if (started === generation)
        view.error = error instanceof Error ? error.message : "Could not update agent settings.";
    } finally {
      if (started === generation) {
        view.busy = null;
        paint();
        invalidate();
      }
    }
  };
  const load = () =>
    request("Loading agent settings…", async () => {
      const started = generation;
      let data: AgentSettings;
      try {
        data = await settingsRequest<AgentSettings>(engine!, "GET");
      } catch (error) {
        if (started === generation && error instanceof Error && error.cause === 403) {
          view.denied = true;
          view.data = null;
          view.error = null;

          journalCaught(error, "agent-settings.createAgentSettings.settingsRequest", null);
          return;
        }
        throw error;
      }
      if (started !== generation) return;
      view.denied = false;
      view.data = data;
      view.presetRows = Object.entries(data.presets ?? {}).map(([name, preset]) => ({
        name,
        preset,
      }));
      view.saved = false;
      view.applyToWaiting = false;
      view.waitingRuns = undefined;
    });
  const click = (event: Event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-settings]");
    if (!button || view.busy || !engine) return;
    const action = button.dataset.settings;
    if (action === "models") {
      void loadCatalog();
      return;
    }
    if (action === "reload") {
      void load();
      return;
    }
    draft();
    if (action === "add-preset" && view.data) {
      view.presetRows ??= [];
      const { implementer, reviewer } = view.data.defaults;
      view.presetRows.push({
        name: "",
        preset: { implementer: { ...implementer }, reviewer: { ...reviewer } },
      });
      paint();
      root?.querySelector<HTMLInputElement>(`#preset-${view.presetRows.length - 1}-name`)?.focus();
    }
    if (action === "remove-preset") {
      view.presetRows?.splice(Number(button.dataset.index), 1);
      paint();
    }
  };
  const submit = (event: Event) => {
    event.preventDefault();
    if (view.busy || !view.data || !engine) return;
    draft();
    const problems = settingsProblems(view.data);
    if (problems.length) {
      view.error = problems.join(" ");
      paint();
      return;
    }
    const rows = view.presetRows ?? [];
    if (rows.some((row) => presetProblem(row))) {
      paint();
      return;
    }
    const names = new Set<string>();
    for (const row of rows) {
      if (names.has(row.name)) {
        view.error = `Duplicate preset: ${row.name}`;
        paint();
        return;
      }
      names.add(row.name);
    }
    view.data!.presets = Object.fromEntries(rows.map(({ name, preset }) => [name, preset]));
    const started = generation;
    void request("Saving agent settings…", async () => {
      const data = await settingsRequest<
        AgentSettings & { waitingRuns?: number; warnings?: string[] }
      >(
        engine!,
        "PUT",
        { ...profilesOnly(view.data!), applyToWaiting: view.applyToWaiting === true },
        readCsrfToken(document),
      );
      if (started !== generation) return;
      const { waitingRuns, warnings, ...settings } = data;
      view.data = settings;
      view.presetRows = Object.entries(settings.presets ?? {}).map(([name, preset]) => ({
        name,
        preset,
      }));
      view.waitingRuns = waitingRuns;
      view.warnings = warnings;
      view.applyToWaiting = false;
      view.saved = true;
      onSaved();
    });
  };
  const change = (event: Event) => {
    if (view.busy) return;
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    if (
      event.type === "input" &&
      (target instanceof HTMLSelectElement || target.type === "checkbox")
    )
      return;
    draft();
    const name = target.name;
    root?.querySelector("#settings-feedback")?.replaceChildren();
    if (name.endsWith("-agent") || name.endsWith("-model")) {
      const key = name.replace(/-(agent|model)$/, "");
      const [scope, first, second] = key.split("-") as [string, AgentRole, AgentRole];
      const role = scope === "preset" ? second : first;
      const profile =
        scope === "preset"
          ? view.presetRows?.[Number(first)]?.preset[role]
          : view.data?.defaults[role];
      if (profile) {
        delete profile.effort;
        if (name.endsWith("-agent")) profile.model = null;
      }
      if (scope !== "preset" && name.endsWith("-agent") && view.data)
        clearAccounts(view.data, role);
      const effort = root?.querySelector<HTMLSelectElement>(`[name="${key}-effort"]`);
      if (effort) effort.value = "";
    }
    if (target instanceof HTMLInputElement && target.type !== "checkbox") {
      const problems = view.data ? settingsProblems(view.data) : [];
      const holder = root?.querySelector<HTMLElement>("#settings-problems");
      if (holder) {
        holder.textContent = problems.join(" ");
        holder.hidden = problems.length === 0;
      }
      const save = root?.querySelector<HTMLButtonElement>('button[type="submit"]');
      if (save) save.disabled = problems.length > 0 || (view.presetRows ?? []).some(presetProblem);
      return;
    }
    paint();
    requestAnimationFrame(() => {
      const field = root?.querySelector<HTMLElement>(`[name="${name}"]`);
      field?.focus();
    });
  };
  return {
    stale() {
      if (!view.busy) view.data = null;
    },
    mount(next, nextEngine) {
      if (root === next && engine === nextEngine) return;
      clearTimeout(catalogTimer);
      root?.removeEventListener("click", click);
      root?.removeEventListener("submit", submit);
      root?.removeEventListener("change", change);
      root?.removeEventListener("input", change);
      const sourceChanged = engine !== nextEngine;
      root = next;
      engine = nextEngine;
      if (sourceChanged) {
        generation += 1;
        view = { data: null, busy: null, error: null, saved: false };
      }
      root.addEventListener("click", click);
      root.addEventListener("submit", submit);
      root.addEventListener("change", change);
      root.addEventListener("input", change);
      if (!engine) {
        view.error = "Connect to your Paws dashboard to edit agent settings.";
        paint();
        const button = root.querySelector<HTMLButtonElement>('[data-settings="reload"]');
        if (button) {
          button.removeAttribute("data-settings");
          button.dataset.action = "source";
          button.textContent = "Connect engine";
        }
      } else {
        if (!view.data && !view.busy && !view.denied) void load();
        else paint();
        void loadCatalog();
      }
    },
  };
}
