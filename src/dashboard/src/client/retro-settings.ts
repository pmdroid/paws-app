import type { AgentModelCatalog } from "../agent-settings";
import { journalCaught } from "../journal";
import {
  compatibleRetroProfile,
  insertRetroVariable,
  parseRetroFrozenSettings,
  parseRetroPreview,
  parseRetroSettingsView,
  RETRO_AGENT_NAMES,
  RETRO_MODELS_API_PATH,
  RETRO_PREVIEW_API_PATH,
  RETRO_PROMPT_MAX_CHARS,
  RETRO_PROMPT_VARIABLES,
  RETRO_SETTINGS_API_PATH,
  RETRO_WEEKDAY_NAMES,
  retroFrozenSettingsPath,
  retroProfileChoices,
  retroPromptProblem,
  retroRenderedPromptPath,
  retroScheduleSummary,
  retroTimeZones,
  sameRetroDraft,
  type RetroFrozenSettings,
  type RetroPreview,
  type RetroSettingsDraft,
  type RetroSettingsProblem,
  type RetroSettingsView,
} from "../retro-settings";
import { readCsrfToken } from "./csrf";
import { esc } from "./format";
import { routeHref } from "./route";
import { renderMarkup } from "./theme";

type Notice = {
  kind: "saved" | "invalid" | "conflict" | "provider" | "failed" | "denied";
  message: string;
};

export type RetroSettingsState = {
  view: RetroSettingsView | null;
  draft: RetroSettingsDraft | null;
  loadError: string | null;
  denied: boolean;
  catalogs: AgentModelCatalog[] | null;
  catalogError: string | null;
  preview: (RetroPreview & { key: string }) | null;
  previewOpen: boolean;
  previewError: { key: string; message: string } | null;
  busy: "save" | "preview" | null;
  notice: Notice | null;
  problems: RetroSettingsProblem[];
  conflict: RetroSettingsView | null;
};

type Frozen =
  | { state: "loading" }
  | { state: "ready"; value: RetroFrozenSettings }
  | { state: "partial" | "missing" | "error" };

const freshState = (): RetroSettingsState => ({
  view: null,
  draft: null,
  loadError: null,
  denied: false,
  catalogs: null,
  catalogError: null,
  preview: null,
  previewOpen: false,
  previewError: null,
  busy: null,
  notice: null,
  problems: [],
  conflict: null,
});

const clone = (draft: RetroSettingsDraft): RetroSettingsDraft =>
  JSON.parse(JSON.stringify(draft)) as RetroSettingsDraft;

export const previewKey = (draft: RetroSettingsDraft) =>
  JSON.stringify({ prompt: draft.prompt, outputLimits: draft.outputLimits });

const problemFor = (state: RetroSettingsState, ...fields: string[]) =>
  state.problems.find((problem) => fields.includes(problem.field))?.message ?? null;

const fieldError = (id: string, message: string | null) =>
  message ? `<small class="err" id="${id}-error" role="alert">${esc(message)}</small>` : "";

const described = (id: string, message: string | null, help?: string) => {
  const ids = [message ? `${id}-error` : "", help ?? ""].filter(Boolean).join(" ");
  return `${ids ? ` aria-describedby="${ids}"` : ""}${message ? ' aria-invalid="true"' : ""}`;
};

function optionList(choices: { id: string; name: string }[], value: string | null) {
  return choices
    .map(
      (choice) =>
        `<option value="${esc(choice.id)}"${choice.id === (value ?? "") ? " selected" : ""}>${esc(choice.name)}</option>`,
    )
    .join("");
}

function profileSection(state: RetroSettingsState, draft: RetroSettingsDraft): string {
  const profile = draft.agentProfile;
  const choices = retroProfileChoices(profile, state.catalogs);
  const unavailable = (kind: "model" | "effort", value: string | null) =>
    value === null ? [] : [{ id: value, name: `${value} (not offered by a signed-in runner)` }];
  const modelChoices = [
    { id: "", name: "Agent default" },
    ...(choices.model === "unavailable" || choices.model === "loading"
      ? unavailable("model", profile.model).map((choice) =>
          choices.model === "loading" ? { ...choice, name: profile.model! } : choice,
        )
      : []),
    ...(choices.models ?? []),
  ];
  const effortChoices = [
    { id: "", name: "Agent default" },
    ...(choices.effort === "unavailable" || choices.effort === "loading"
      ? unavailable("effort", profile.effort).map((choice) =>
          choices.effort === "loading" ? { ...choice, name: profile.effort! } : choice,
        )
      : []),
    ...(choices.efforts ?? []),
  ];
  const modelProblem =
    problemFor(state, "agentProfile.model") ??
    (choices.model === "unavailable"
      ? `No signed-in runner offers ${profile.model} for ${RETRO_AGENT_NAMES[profile.agent]}. Choose another model or the agent default.`
      : null);
  const effortProblem =
    problemFor(state, "agentProfile.effort") ??
    (choices.effort === "unavailable"
      ? `${profile.effort} effort is not offered for this model. Choose another effort or the agent default.`
      : null);
  const catalogLine =
    state.catalogs === null
      ? `<small class="sub" role="status" id="retro-catalog-status">${esc(state.catalogError ?? "Loading model choices from signed-in runners… Your selection is kept.")}</small>`
      : `<small class="sub" id="retro-catalog-status">Choices come from your signed-in <a href="${esc(routeHref({ view: "runners", id: null }))}">Runners</a>.</small>`;
  return `<section class="settings-section" aria-labelledby="retro-agent-heading"><div class="settings-label"><h2 id="retro-agent-heading">Agent</h2><p class="sub">Run the retro on a compatible paired runner.</p></div><div class="settings-controls">
    <div class="settings-field"><label for="retro-agent">Agent</label><select id="retro-agent" name="retro-agent"${described("retro-agent", problemFor(state, "agentProfile.agent"))}>${optionList(
      Object.entries(RETRO_AGENT_NAMES).map(([id, name]) => ({ id, name })),
      profile.agent,
    )}</select>${fieldError("retro-agent", problemFor(state, "agentProfile.agent"))}</div>
    <div class="settings-field"><label for="retro-model">Model</label><select id="retro-model" name="retro-model"${described("retro-model", modelProblem, "retro-catalog-status")}>${optionList(modelChoices, profile.model)}</select>${fieldError("retro-model", modelProblem)}</div>
    <div class="settings-field"><label for="retro-effort">Reasoning effort</label><select id="retro-effort" name="retro-effort"${described("retro-effort", effortProblem)}>${optionList(effortChoices, profile.effort)}</select>${fieldError("retro-effort", effortProblem)}</div>
    ${catalogLine}</div></section>`;
}

function promptSection(state: RetroSettingsState, draft: RetroSettingsDraft): string {
  const local = retroPromptProblem(draft.prompt);
  const problem = local ?? problemFor(state, "prompt");
  const key = previewKey(draft);
  const preview = state.preview;
  const previewBody = !state.previewOpen
    ? ""
    : state.previewError && state.previewError.key === key
      ? `<p class="err" role="alert">${esc(state.previewError.message)}</p>`
      : preview === null
        ? `<p class="sub" role="status">${state.busy === "preview" ? "Rendering the preview…" : "Select Preview prompt to render the draft."}</p>`
        : `<p class="sub" role="status" id="retro-preview-label">${esc(preview.key === key ? preview.label : "The draft changed after this preview. Preview again to see the current draft.")}</p><pre class="retro-prompt-preview" id="retro-prompt-preview" tabindex="0" aria-labelledby="retro-preview-label" data-scroll-key="retro-preview">${esc(preview.text)}</pre>`;
  return `<section class="settings-section" aria-labelledby="retro-prompt-heading"><div class="settings-label"><h2 id="retro-prompt-heading">Prompt</h2><p class="sub">Write the full instructions the retro agent receives.</p></div><div class="settings-controls">
    <div class="settings-field"><label for="retro-prompt">Retro instructions</label><textarea id="retro-prompt" name="retro-prompt" rows="16" maxlength="${RETRO_PROMPT_MAX_CHARS}" spellcheck="true"${described("retro-prompt", problem, "retro-prompt-help")}>${esc(draft.prompt)}</textarea>
    <small class="err" id="retro-prompt-error" role="alert" data-retro-live="prompt">${esc(problem ?? "")}</small>
    <small class="sub" id="retro-prompt-help">Insert a variable at the cursor. The prompt must include {{digest}} exactly once.</small></div>
    <div class="row" role="group" aria-label="Insert a variable">${RETRO_PROMPT_VARIABLES.map((name) => `<button class="btn" type="button" data-retro-variable="${name}" aria-label="Insert ${name} variable">{{${name}}}</button>`).join("")}</div>
    <div class="row"><button class="btn" type="button" data-retro="preview" aria-expanded="${state.previewOpen}" aria-controls="retro-preview"${state.busy === "preview" ? " disabled" : ""}>${state.previewOpen ? "Preview again" : "Preview prompt"}</button>${state.previewOpen ? '<button class="btn" type="button" data-retro="hide-preview">Hide preview</button>' : ""}<button class="btn" type="button" data-retro="restore">Restore default prompt</button></div>
    <small class="sub">Preview renders this draft, including unsaved edits. Restore default changes only the draft until you save.</small>
    <div id="retro-preview">${previewBody}</div></div></section>`;
}

function numberField(
  state: RetroSettingsState,
  id: string,
  label: string,
  field: string,
  value: number,
  bounds: { min: number; max: number },
) {
  const problem = problemFor(state, field);
  return `<div class="settings-field"><label for="${id}">${label}</label><input id="${id}" name="${id}" type="number" inputmode="numeric" step="1" min="${bounds.min}" max="${bounds.max}" value="${Number.isFinite(value) ? value : ""}" required${described(id, problem)}>${fieldError(id, problem)}</div>`;
}

function outputSection(
  state: RetroSettingsState,
  view: RetroSettingsView,
  draft: RetroSettingsDraft,
) {
  const selected = new Set(draft.repositories.map((name) => name.toLowerCase()));
  const denied = new Set(view.inaccessibleRepositories.map((name) => name.toLowerCase()));
  const names = [
    ...view.accessibleRepositories,
    ...draft.repositories.filter(
      (name) =>
        !view.accessibleRepositories.some((other) => other.toLowerCase() === name.toLowerCase()),
    ),
  ];
  const repositories = names.length
    ? names
        .map((name) => {
          const lost =
            denied.has(name.toLowerCase()) || !view.accessibleRepositories.includes(name);
          return `<label class="settings-inherit"><input type="checkbox" name="retro-repository" value="${esc(name)}"${selected.has(name.toLowerCase()) ? " checked" : ""}>${esc(name)}${lost ? ' <span class="err">Paws cannot access this repository. Clear it before saving.</span>' : ""}</label>`;
        })
        .join("")
    : '<p class="sub">Paws cannot access any repository in this workspace yet.</p>';
  const problem = problemFor(state, "repositories");
  return `<section class="settings-section" aria-labelledby="retro-output-heading"><div class="settings-label"><h2 id="retro-output-heading">Sessions and output</h2><p class="sub">Choose which sessions to read and how much to propose.</p></div><div class="settings-controls">
    <fieldset class="settings-field"><legend>Repositories</legend>${repositories}${fieldError("retro-repositories", problem)}<small class="sub">New activity since the previous successful retro, including older sessions with new events. A newly added repository starts from its own history.</small></fieldset>
    ${numberField(state, "retro-max-items", "Maximum patterns", "outputLimits.maxItems", draft.outputLimits.maxItems, view.limits.maxItems)}
    ${numberField(state, "retro-worked-well", "Worked well observations", "outputLimits.workedWell", draft.outputLimits.workedWell, view.limits.workedWell)}
    </div></section>`;
}

function scheduleSection(state: RetroSettingsState, draft: RetroSettingsDraft) {
  const schedule = draft.schedule;
  const paused = schedule.cadence === "paused";
  const timeProblem = problemFor(state, "schedule.time");
  const zoneProblem = problemFor(state, "schedule.timeZone");
  return `<section class="settings-section" aria-labelledby="retro-schedule-heading"><div class="settings-label"><h2 id="retro-schedule-heading">Schedule</h2><p class="sub">Pick a weekly time or pause automatic retros.</p></div><div class="settings-controls">
    <div class="settings-field"><label for="retro-cadence">Frequency</label><select id="retro-cadence" name="retro-cadence">${optionList(
      [
        { id: "weekly", name: "Weekly" },
        { id: "paused", name: "Paused" },
      ],
      schedule.cadence,
    )}</select></div>
    <div class="settings-field"><label for="retro-weekday">Day</label><select id="retro-weekday" name="retro-weekday"${paused ? ' aria-describedby="retro-next-run"' : ""}>${optionList(
      Object.entries(RETRO_WEEKDAY_NAMES).map(([id, name]) => ({ id, name })),
      schedule.weekday,
    )}</select></div>
    <div class="settings-field"><label for="retro-time">Local time</label><input id="retro-time" name="retro-time" type="time" value="${esc(schedule.time)}" required${described("retro-time", timeProblem)}>${fieldError("retro-time", timeProblem)}</div>
    <div class="settings-field"><label for="retro-time-zone">Time zone</label><select id="retro-time-zone" name="retro-time-zone"${described("retro-time-zone", zoneProblem)}>${optionList(
      retroTimeZones(schedule.timeZone).map((zone) => ({ id: zone, name: zone })),
      schedule.timeZone,
    )}</select>${fieldError("retro-time-zone", zoneProblem)}</div>
    <small class="sub" id="retro-next-run" role="status" data-retro-live="schedule">${esc(retroScheduleSummary(schedule))}</small>
    </div></section>`;
}

function limitsSection(
  state: RetroSettingsState,
  view: RetroSettingsView,
  draft: RetroSettingsDraft,
) {
  return `<section class="settings-section" aria-labelledby="retro-limits-heading"><div class="settings-label"><h2 id="retro-limits-heading">Run limits</h2><p class="sub">Limit agent time and retries for each retro.</p></div><div class="settings-controls">
    ${numberField(state, "retro-active-minutes", "Execution time limit, minutes", "executionLimits.activeMinutes", draft.executionLimits.activeMinutes, view.limits.activeMinutes)}
    ${numberField(state, "retro-retries", "Generation retries", "executionLimits.retries", draft.executionLimits.retries, view.limits.retries)}
    <small class="sub">Only active agent time counts. Waiting for runner capacity or a provider's quota cooldown spends no execution minutes. A retry reuses the same evidence and frozen settings.</small>
    </div></section>`;
}

function noticeMarkup(state: RetroSettingsState): string {
  const notice = state.notice;
  if (!notice) return "";
  const role = notice.kind === "saved" ? "status" : "alert";
  const tone = notice.kind === "saved" ? "" : " err";
  const recover =
    notice.kind === "conflict" && state.conflict
      ? ` <button class="btn" type="button" data-retro="take-theirs">Discard my draft and load revision ${state.conflict.revision}</button>`
      : notice.kind === "provider"
        ? ` <button class="btn" type="button" data-retro="reload-models">Reload choices</button>`
        : "";
  return `<p class="settings-message${tone}" role="${role}" data-retro-notice="${notice.kind}">${esc(notice.message)}${recover}</p>`;
}

export function renderRetroSettings(state: RetroSettingsState): string {
  const findings = `<p class="sub">Daily findings keep their own toggle and cadence in <a href="${esc(routeHref({ view: "settings", page: "findings" }))}">Finding settings</a>.</p>`;
  if (state.denied)
    return `<section class="card col" aria-labelledby="retro-settings-heading"><h2 id="retro-settings-heading">Retro settings</h2><p role="alert">${esc(state.notice?.message ?? "You no longer have access to retro settings in this workspace.")}</p>${findings}</section>`;
  const view = state.view;
  const draft = state.draft;
  if (view === null || draft === null)
    return `<section class="card col" aria-labelledby="retro-settings-heading"><h2 id="retro-settings-heading">Retro settings</h2>${
      state.loadError
        ? `<p role="alert">${esc(state.loadError)}</p><div class="row"><button class="btn" type="button" data-retro="reload">Retry</button></div>`
        : '<p role="status">Loading retro settings…</p>'
    }</section>`;
  const dirty = !sameRetroDraft(draft, view.settings);
  const base = state.conflict ?? view;
  const readOnly = !view.canEdit;
  const status = readOnly
    ? "Read only"
    : dirty
      ? "Unsaved changes"
      : view.saved
        ? `Saved revision ${view.revision}`
        : "Proposed defaults, not saved yet";
  const intro = readOnly
    ? "Only workspace admins can change retro settings. You can read the saved settings."
    : view.saved
      ? "Choose the agent, instructions and sessions for each weekly retro."
      : "These are proposed values. No retro runs on a schedule until an admin saves them.";
  const footer = readOnly
    ? ""
    : `<div class="row retro-settings-footer"><p class="sub">Saved changes apply to the next retro. Run retro always uses the saved revision; queued and generating retros keep the prompt, agent and limits they started with.</p><button class="btn" type="button" data-retro="cancel"${dirty || state.conflict ? "" : " disabled"}>Cancel changes</button><button class="btn primary" type="submit"${state.busy === "save" ? " disabled" : ""}>${state.busy === "save" ? "Saving…" : state.conflict ? `Save over revision ${base.revision}` : "Save settings"}</button></div>`;
  return `<form class="col" id="retro-settings-form" aria-labelledby="retro-settings-heading" novalidate data-retro-form=""><div class="row"><div class="col"><h2 id="retro-settings-heading">Retro settings</h2><p class="sub">${esc(intro)}</p></div><span class="sub" role="status" data-retro-live="dirty">${esc(status)}</span></div>${findings}${noticeMarkup(state)}<fieldset class="col"${readOnly ? " disabled" : ""}><legend class="sr-only">Retro settings</legend>${profileSection(state, draft)}${promptSection(state, draft)}${outputSection(state, view, draft)}${scheduleSection(state, draft)}${limitsSection(state, view, draft)}</fieldset>${footer}</form>`;
}

export function renderRetroFrozenSettings(frozen: Frozen): string {
  if (frozen.state === "loading")
    return '<p class="muted" role="status">Loading the settings this retro ran with…</p>';
  if (frozen.state === "partial")
    return '<p class="muted">The frozen prompt and agent are shown only to people who can read every repository in this retro.</p>';
  if (frozen.state !== "ready") return "";
  const value = frozen.value;
  const profile = value.agentProfile;
  const agent = RETRO_AGENT_NAMES[profile.agent as keyof typeof RETRO_AGENT_NAMES] ?? profile.agent;
  const facts: [string, string][] = [
    ["Settings revision", String(value.settingsRevision)],
    ["Agent", agent],
    ["Model", profile.model ?? "Agent default"],
    ["Reasoning effort", profile.effort ?? "Agent default"],
    ["Repositories", value.repositories.join(", ")],
    [
      "Output",
      `${value.outputLimits.maxItems ?? "?"} patterns, ${value.outputLimits.workedWell ?? "?"} worked-well observations`,
    ],
    [
      "Run limits",
      `${value.executionLimits.activeMinutes ?? "?"} active minutes, ${value.executionLimits.retries ?? "?"} retries`,
    ],
  ];
  const download = value.renderedPrompt
    ? `<a class="btn" href="${esc(retroRenderedPromptPath(value.retroId))}" download>Download the rendered prompt</a>`
    : '<p class="muted">The rendered prompt is saved when a runner starts the retro.</p>';
  return `<details class="improvement-part" data-retro-frozen-details=""><summary>Settings this retro ran with</summary><p class="muted">Frozen when the retro started. Later settings changes do not affect it or its retries.</p><dl class="kv">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl><h4>Prompt template</h4><pre class="retro-prompt-preview" tabindex="0">${esc(value.prompt)}</pre>${download}</details>`;
}

export type RetroSettingsOptions = {
  fetch?: (...args: Parameters<typeof fetch>) => Promise<Response>;
  csrf?: () => string;
  paint?: (root: HTMLElement, html: string) => void;
};

export function createRetroSettings(options: RetroSettingsOptions = {}) {
  const fetchImpl = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const csrf = options.csrf ?? (() => readCsrfToken(document));
  const draw = options.paint ?? renderMarkup;
  let scope = "";
  let engine = "";
  let epoch = 0;
  let state = freshState();
  let root: HTMLElement | null = null;
  let loading = false;
  let catalogLoading = false;
  let cursor: [number, number] | null = null;
  const frozen = new Map<string, Frozen>();
  const frozenRoots = new Map<string, HTMLElement>();

  const request = async (path: string, init?: RequestInit) => {
    const response = await fetchImpl(new URL(path, engine), {
      cache: "no-store",
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body !== undefined
          ? { "Content-Type": "application/json", "x-paws-csrf": csrf() }
          : {}),
      },
    });
    return { status: response.status, body: (await response.json().catch(() => null)) as unknown };
  };
  const errorOf = (body: unknown, fallback: string) =>
    typeof (body as { error?: unknown } | null)?.error === "string"
      ? (body as { error: string }).error
      : fallback;

  const lose = (message: string) => {
    state = { ...freshState(), denied: true, notice: { kind: "denied", message } };
    frozen.clear();
  };

  const paint = () => {
    if (!root?.isConnected) return;
    const active = document.activeElement;
    const focused =
      active instanceof HTMLElement && root.contains(active)
        ? active.id
          ? `#${CSS.escape(active.id)}`
          : active.dataset.retroVariable
            ? `[data-retro-variable="${active.dataset.retroVariable}"]`
            : active.dataset.retro
              ? `[data-retro="${active.dataset.retro}"]`
              : active instanceof HTMLInputElement && active.name === "retro-repository"
                ? `[name="retro-repository"][value="${CSS.escape(active.value)}"]`
                : null
        : null;
    const selection =
      active instanceof HTMLTextAreaElement ||
      (active instanceof HTMLInputElement && active.type === "text")
        ? [active.selectionStart, active.selectionEnd]
        : null;
    draw(root, renderRetroSettings(state));
    const target = focused ? root.querySelector<HTMLElement>(focused) : null;
    if (target) {
      target.focus({ preventScroll: true });
      if (selection && target instanceof HTMLTextAreaElement)
        target.setSelectionRange(selection[0] ?? null, selection[1] ?? null);
    }
  };

  const live = () => {
    if (!root || !state.draft || !state.view) return;
    const problem = retroPromptProblem(state.draft.prompt);
    const prompt = root.querySelector<HTMLElement>('[data-retro-live="prompt"]');
    if (prompt) prompt.textContent = problem ?? "";
    root.querySelector("#retro-prompt")?.setAttribute("aria-invalid", String(problem !== null));
    const schedule = root.querySelector<HTMLElement>('[data-retro-live="schedule"]');
    if (schedule) schedule.textContent = retroScheduleSummary(state.draft.schedule);
    const dirty = !sameRetroDraft(state.draft, state.view.settings);
    const marker = root.querySelector<HTMLElement>('[data-retro-live="dirty"]');
    if (marker && state.view.canEdit)
      marker.textContent = dirty ? "Unsaved changes" : `Saved revision ${state.view.revision}`;
    const cancel = root.querySelector<HTMLButtonElement>('[data-retro="cancel"]');
    if (cancel) cancel.disabled = !dirty && state.conflict === null;
  };

  const load = async () => {
    if (loading || !engine) return;
    loading = true;
    const started = epoch;
    try {
      const answer = await request(RETRO_SETTINGS_API_PATH);
      if (started !== epoch) return;
      if (answer.status === 401 || answer.status === 403)
        lose(
          errorOf(answer.body, "You no longer have access to retro settings in this workspace."),
        );
      else {
        const view = parseRetroSettingsView(answer.body);
        if (answer.status !== 200 || view === null)
          state.loadError = errorOf(
            answer.body,
            "Retro settings could not be loaded. Retry in a moment.",
          );
        else {
          state.view = view;
          state.loadError = null;
          if (state.draft === null) state.draft = clone(view.settings);
        }
      }
    } catch (error) {
      journalCaught(error, "retro-settings.load", null);
      if (started === epoch) state.loadError = "Paws did not answer. Retry in a moment.";
    } finally {
      if (started === epoch) loading = false;
    }
    if (started === epoch) paint();
  };

  const loadCatalog = async () => {
    if (catalogLoading || !engine) return;
    catalogLoading = true;
    const started = epoch;
    try {
      const answer = await request(RETRO_MODELS_API_PATH);
      if (started !== epoch) return;
      const catalogs = (answer.body as { catalogs?: unknown } | null)?.catalogs;
      if (answer.status === 200 && Array.isArray(catalogs)) {
        state.catalogs = catalogs as AgentModelCatalog[];
        state.catalogError = null;
      } else
        state.catalogError =
          "Model choices could not be loaded from signed-in runners. Your selection is kept.";
    } catch (error) {
      journalCaught(error, "retro-settings.catalog", null);
      if (started === epoch)
        state.catalogError =
          "Model choices could not be loaded from signed-in runners. Your selection is kept.";
    } finally {
      if (started === epoch) catalogLoading = false;
    }
    if (started === epoch) paint();
  };

  const preview = async () => {
    if (!state.draft || state.busy !== null) return;
    const draft = state.draft;
    const key = previewKey(draft);
    state.previewOpen = true;
    const local = retroPromptProblem(draft.prompt);
    if (local) {
      state.previewError = { key, message: local };
      paint();
      return;
    }
    const started = epoch;
    state.busy = "preview";
    state.previewError = null;
    paint();
    try {
      const answer = await request(RETRO_PREVIEW_API_PATH, {
        method: "POST",
        body: JSON.stringify({ prompt: draft.prompt, outputLimits: draft.outputLimits }),
      });
      if (started !== epoch) return;
      if (answer.status === 401 || answer.status === 403)
        lose(errorOf(answer.body, "You no longer have access to preview retro prompts."));
      else {
        const parsed = parseRetroPreview(answer.body);
        if (answer.status === 200 && parsed) state.preview = { ...parsed, key };
        else
          state.previewError = {
            key,
            message: errorOf(answer.body, "The preview could not be rendered. Your draft is kept."),
          };
      }
    } catch (error) {
      journalCaught(error, "retro-settings.preview", null);
      if (started === epoch)
        state.previewError = {
          key,
          message: "Paws did not answer. Your draft is kept; preview again.",
        };
    }
    if (started !== epoch) return;
    state.busy = null;
    paint();
  };

  const save = async () => {
    const view = state.view;
    if (!view || !state.draft || state.busy !== null || !view.canEdit) return;
    const sent = clone(state.draft);
    const expectedRevision = (state.conflict ?? view).revision;
    const local = retroPromptProblem(sent.prompt);
    if (local) {
      state.problems = [{ field: "prompt", message: local }];
      state.notice = { kind: "invalid", message: "Fix the highlighted fields. Nothing was saved." };
      paint();
      root?.querySelector<HTMLElement>("#retro-prompt")?.focus();
      return;
    }
    const started = epoch;
    state.busy = "save";
    state.notice = null;
    paint();
    try {
      const answer = await request(RETRO_SETTINGS_API_PATH, {
        method: "PUT",
        body: JSON.stringify({ expectedRevision, settings: sent }),
      });
      if (started !== epoch) return;
      const body = answer.body as {
        reason?: string;
        problems?: RetroSettingsProblem[];
        current?: unknown;
      } | null;
      if (answer.status === 401 || (answer.status === 403 && body?.reason === undefined))
        lose(errorOf(answer.body, "You no longer have access to change retro settings."));
      else if (answer.status === 200) {
        const saved = parseRetroSettingsView(answer.body);
        if (saved) {
          state.view = saved;
          state.conflict = null;
          state.problems = [];
          if (state.draft && sameRetroDraft(state.draft, sent)) state.draft = clone(saved.settings);
          state.notice = {
            kind: "saved",
            message: `Saved revision ${saved.revision}. ${retroScheduleSummary(saved.settings.schedule)} The next retro uses these settings.`,
          };
        }
      } else if (answer.status === 409 && body?.reason === "conflict") {
        state.conflict = parseRetroSettingsView(body.current);
        state.notice = {
          kind: "conflict",
          message: errorOf(
            answer.body,
            "Someone saved retro settings after you started editing. Your draft is unchanged.",
          ),
        };
      } else if (body?.reason === "catalog_unavailable") {
        state.problems = body.problems ?? [];
        state.notice = {
          kind: "provider",
          message: `${errorOf(answer.body, "No signed-in runner has reported this agent's choices.")} This is a runner availability problem, not an invalid setting. Your draft is kept.`,
        };
      } else if (answer.status === 400 || answer.status === 503) {
        state.problems = body?.problems ?? [];
        state.notice = {
          kind: "invalid",
          message: `${errorOf(answer.body, "Some settings are invalid.")} Nothing was saved; your draft is kept.`,
        };
      } else
        state.notice = {
          kind: "failed",
          message: `${errorOf(answer.body, "Saving failed.")} Your draft is kept; try again.`,
        };
    } catch (error) {
      journalCaught(error, "retro-settings.save", null);
      if (started === epoch)
        state.notice = {
          kind: "failed",
          message: "Paws did not answer. Your draft is kept; try again.",
        };
    }
    if (started !== epoch) return;
    state.busy = null;
    paint();
    root?.querySelector<HTMLElement>("[data-retro-notice]")?.scrollIntoView?.({ block: "nearest" });
  };

  const setProfile = (agentProfile: RetroSettingsDraft["agentProfile"]) => {
    if (!state.draft) return;
    state.draft.agentProfile = agentProfile;
    state.problems = state.problems.filter((problem) => !problem.field.startsWith("agentProfile"));
  };

  const readNumber = (value: string) => (value.trim() === "" ? Number.NaN : Number(value));

  const onInput = (event: Event) => {
    const target = event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    const draft = state.draft;
    if (!draft || !state.view?.canEdit) return;
    switch (target.name) {
      case "retro-prompt":
        draft.prompt = target.value;
        if (target instanceof HTMLTextAreaElement)
          cursor = [target.selectionStart, target.selectionEnd];
        break;
      case "retro-max-items":
        draft.outputLimits.maxItems = readNumber(target.value);
        break;
      case "retro-worked-well":
        draft.outputLimits.workedWell = readNumber(target.value);
        break;
      case "retro-active-minutes":
        draft.executionLimits.activeMinutes = readNumber(target.value);
        break;
      case "retro-retries":
        draft.executionLimits.retries = readNumber(target.value);
        break;
      case "retro-time":
        draft.schedule.time = target.value;
        break;
      default:
        return;
    }
    if (state.notice?.kind === "saved") state.notice = null;
    live();
  };

  const onChange = (event: Event) => {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    const draft = state.draft;
    if (!draft || !state.view?.canEdit) return;
    const profile = draft.agentProfile;
    switch (target.name) {
      case "retro-agent":
        setProfile({ agent: target.value as typeof profile.agent, model: null, effort: null });
        break;
      case "retro-model":
        setProfile(
          compatibleRetroProfile({ ...profile, model: target.value || null }, state.catalogs),
        );
        break;
      case "retro-effort":
        setProfile({ ...profile, effort: target.value || null });
        break;
      case "retro-repository": {
        const name = (target as HTMLInputElement).value;
        draft.repositories = (target as HTMLInputElement).checked
          ? [...draft.repositories, name]
          : draft.repositories.filter((other) => other.toLowerCase() !== name.toLowerCase());
        break;
      }
      case "retro-cadence":
        draft.schedule.cadence = target.value === "paused" ? "paused" : "weekly";
        break;
      case "retro-weekday":
        draft.schedule.weekday = target.value as typeof draft.schedule.weekday;
        break;
      case "retro-time-zone":
        draft.schedule.timeZone = target.value;
        break;
      case "retro-time":
        draft.schedule.time = target.value;
        break;
      default:
        return;
    }
    if (state.notice?.kind === "saved") state.notice = null;
    paint();
  };

  const onSelect = (event: Event) => {
    const target = event.target;
    if (target instanceof HTMLTextAreaElement && target.name === "retro-prompt")
      cursor = [target.selectionStart, target.selectionEnd];
  };

  const insert = (name: string) => {
    const editor = root?.querySelector<HTMLTextAreaElement>("#retro-prompt");
    if (!editor || !state.draft) return;
    const [start, end] = cursor ?? [editor.value.length, editor.value.length];
    const next = insertRetroVariable(editor.value, start, end, name);
    editor.value = next.value;
    state.draft.prompt = next.value;
    cursor = [next.cursor, next.cursor];
    editor.focus();
    editor.setSelectionRange(next.cursor, next.cursor);
    live();
  };

  const onMouseDown = (event: Event) => {
    if ((event.target as Element).closest?.("[data-retro-variable]")) event.preventDefault();
  };

  const onClick = (event: Event) => {
    const element = (event.target as Element).closest<HTMLElement>(
      "[data-retro-variable], [data-retro]",
    );
    if (!element) return;
    const variable = element.dataset.retroVariable;
    if (variable) return insert(variable);
    const action = element.dataset.retro;
    if (action === "preview") void preview();
    else if (action === "hide-preview") {
      state.previewOpen = false;
      paint();
      root?.querySelector<HTMLElement>('[data-retro="preview"]')?.focus();
    } else if (action === "restore" && state.draft && state.view) {
      state.draft.prompt = state.view.defaultPrompt;
      state.problems = state.problems.filter((problem) => problem.field !== "prompt");
      cursor = null;
      paint();
      root?.querySelector<HTMLElement>("#retro-prompt")?.focus();
    } else if (action === "cancel" && state.view) {
      const base = state.conflict ?? state.view;
      state.view = base;
      state.draft = clone(base.settings);
      state.conflict = null;
      state.problems = [];
      state.notice = null;
      paint();
      root?.querySelector<HTMLElement>("#retro-agent")?.focus();
    } else if (action === "take-theirs" && state.conflict) {
      state.view = state.conflict;
      state.draft = clone(state.conflict.settings);
      state.conflict = null;
      state.problems = [];
      state.notice = null;
      paint();
    } else if (action === "reload") void load();
    else if (action === "reload-models") void loadCatalog();
  };

  const onSubmit = (event: Event) => {
    if (!(event.target as HTMLElement).matches?.("[data-retro-form]")) return;
    event.preventDefault();
    event.stopPropagation();
    void save();
  };

  const listeners: [string, EventListener][] = [
    ["input", onInput],
    ["change", onChange],
    ["select", onSelect],
    ["keyup", onSelect],
    ["click", onClick],
    ["mousedown", onMouseDown],
    ["submit", onSubmit],
  ];

  const loadFrozen = async (retroId: string) => {
    const started = epoch;
    frozen.set(retroId, { state: "loading" });
    try {
      const answer = await request(retroFrozenSettingsPath(retroId));
      if (started !== epoch) return;
      const value = parseRetroFrozenSettings(answer.body);
      frozen.set(
        retroId,
        answer.status === 200 && value
          ? { state: "ready", value }
          : answer.status === 403
            ? { state: "partial" }
            : answer.status === 404
              ? { state: "missing" }
              : { state: "error" },
      );
    } catch (error) {
      journalCaught(error, "retro-settings.frozen", null);
      if (started === epoch) frozen.set(retroId, { state: "error" });
    }
    const target = frozenRoots.get(retroId);
    if (started === epoch && target?.isConnected)
      draw(target, renderRetroFrozenSettings(frozen.get(retroId)!));
  };

  return {
    attach(container: HTMLElement, nextEngine: string, reader: string) {
      const key = `${nextEngine}|${reader}`;
      if (key !== scope) {
        scope = key;
        epoch++;
        state = freshState();
        loading = false;
        catalogLoading = false;
        cursor = null;
        frozen.clear();
      }
      engine = nextEngine;
      const next = container.querySelector<HTMLElement>("[data-retro-settings]");
      if (next !== root) {
        for (const [type, listener] of listeners) root?.removeEventListener(type, listener);
        root = next;
        for (const [type, listener] of listeners) root?.addEventListener(type, listener);
      }
      if (root) {
        paint();
        if (state.view === null && !state.denied) void load();
        if (state.catalogs === null) void loadCatalog();
      }
      frozenRoots.clear();
      for (const target of container.querySelectorAll<HTMLElement>("[data-retro-frozen]")) {
        const retroId = target.dataset.retroFrozen!;
        frozenRoots.set(retroId, target);
        const known = frozen.get(retroId);
        if (known === undefined || known.state === "error") void loadFrozen(retroId);
        draw(target, renderRetroFrozenSettings(frozen.get(retroId)!));
      }
    },
    state: () => state,
  };
}
