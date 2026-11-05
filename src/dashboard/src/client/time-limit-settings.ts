import { journalCaught } from "../journal";
import { TIME_STAGES, type TimeStage } from "../contract";
import { readCsrfToken } from "./csrf";
import { esc } from "./format";
import { renderMarkup } from "./theme";

type Minutes = { implementationMinutes?: number; fixesMinutes?: number; closeoutMinutes?: number };
export type TimeLimitSettings = {
  configured: boolean;
  default: Required<Minutes>;
  projects: (Minutes & { id: string })[];
};
type Mode = "limit" | "off" | "inherit";
type StageDraft = Record<TimeStage, { mode: Mode; minutes: string }>;
export type TimeLimitDraft = {
  default: StageDraft;
  projects: { id: string; stages: StageDraft }[];
};
export type TimeLimitView = {
  draft: TimeLimitDraft | null;
  busy: string | null;
  error: string | null;
  saved: boolean;
  fieldErrors: Record<string, string>;
  denied?: boolean;
  projectDraft?: string;
};

const PATH = "/api/settings/time-limits";
const MAX_MINUTES = 7 * 24 * 60;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;
const KEY: Record<TimeStage, keyof Minutes> = {
  implementation: "implementationMinutes",
  fixes: "fixesMinutes",
  closeout: "closeoutMinutes",
};
const LABEL: Record<TimeStage, [string, string]> = {
  implementation: ["Implementation", "The agent's first turns on the issue."],
  fixes: ["Fix rounds", "CI, review comments, findings and conflicts."],
  closeout: ["Closeout", "Checks and reviews of each head."],
};

function stagesDraft(minutes: Minutes, inherit: boolean): StageDraft {
  const stage = (key: keyof Minutes) => {
    const value = minutes[key];
    if (value === undefined) return { mode: inherit ? "inherit" : "off", minutes: "" } as const;
    return value === 0
      ? ({ mode: "off", minutes: "" } as const)
      : ({ mode: "limit", minutes: String(value) } as const);
  };
  return {
    implementation: stage("implementationMinutes"),
    fixes: stage("fixesMinutes"),
    closeout: stage("closeoutMinutes"),
  };
}

export function timeLimitDraft(data: TimeLimitSettings): TimeLimitDraft {
  return {
    default: stagesDraft(data.default, false),
    projects: data.projects.map(({ id, ...minutes }) => ({
      id,
      stages: stagesDraft(minutes, true),
    })),
  };
}

export function timeLimitBody(draft: TimeLimitDraft):
  | { body: { default: Required<Minutes>; projects: (Minutes & { id: string })[] } }
  | {
      errors: Record<string, string>;
    } {
  const errors: Record<string, string> = {};
  const read = (scope: string, stages: StageDraft): Minutes =>
    Object.fromEntries(
      TIME_STAGES.flatMap((stage) => {
        const { mode, minutes } = stages[stage];
        if (mode === "inherit") return [];
        if (mode === "off") return [[KEY[stage], 0]];
        const value = Number(minutes.trim());
        if (!/^\d+$/.test(minutes.trim()) || value < 1 || value > MAX_MINUTES)
          errors[`${scope}-${stage}`] = `Enter whole minutes from 1 to ${MAX_MINUTES}.`;
        return [[KEY[stage], value]];
      }),
    );
  const body = {
    default: read("default", draft.default) as Required<Minutes>,
    projects: draft.projects.map((project, index) => ({
      id: project.id,
      ...read(`project-${index}`, project.stages),
    })),
  };
  return Object.keys(errors).length ? { errors } : { body };
}

function stageField(scope: string, stage: TimeStage, draft: StageDraft, view: TimeLimitView) {
  const id = `time-${scope}-${stage}`;
  const { mode, minutes } = draft[stage];
  const [label, help] = LABEL[stage];
  const error = view.fieldErrors[`${scope}-${stage}`];
  const modes: [Mode, string][] = [
    ...(scope === "default" ? [] : [["inherit", "Workspace default"] as [Mode, string]]),
    ["limit", "Minutes"],
    ["off", "Not counted"],
  ];
  const input =
    mode === "limit"
      ? `<input id="${id}" name="${id}" type="number" min="1" max="${MAX_MINUTES}" step="1" inputmode="numeric" value="${esc(minutes)}" aria-label="${label} minutes"${error ? ` aria-invalid="true" aria-describedby="${id}-error"` : ""}>`
      : "";
  return `<div class="settings-field"><label for="${id}-mode">${label}</label><div class="row"><select id="${id}-mode" name="${id}-mode">${modes.map(([value, text]) => `<option value="${value}" ${value === mode ? "selected" : ""}>${text}</option>`).join("")}</select>${input}</div><small class="sub">${help}</small>${error ? `<p class="time-limit-error" id="${id}-error" role="alert">${esc(error)}</p>` : ""}</div>`;
}

const intro =
  '<div class="settings-label"><h2>Time limits</h2><p class="sub">Paws asks whether to continue when a stage passes its limit. A stage that is not counted has no limit.</p></div>';

export function renderTimeLimitSettings(view: TimeLimitView): string {
  if (view.denied)
    return `<section class="settings-section">${intro}<p class="sub">Only workspace admins can change time limits.</p></section>`;
  const draft = view.draft;
  if (!draft)
    return `<section class="settings-section">${intro}<div class="col"><div class="settings-message" role="${view.error ? "alert" : "status"}">${esc(view.error ?? "Loading time limits…")}</div>${view.error ? '<div class="row"><button class="btn" type="button" data-time-limits="reload">Try again</button></div>' : ""}</div></section>`;
  const feedback = view.error
    ? `<p class="settings-message err" role="alert">${esc(view.error)}</p>`
    : view.busy
      ? `<p class="settings-message" role="status">${esc(view.busy)}</p>`
      : view.saved
        ? '<p class="settings-message" role="status">Saved</p>'
        : "";
  const fields = (scope: string, stages: StageDraft) =>
    TIME_STAGES.map((stage) => stageField(scope, stage, stages, view)).join("");
  const projects = draft.projects.length
    ? draft.projects
        .map(
          (project, index) =>
            `<section class="settings-project"><div class="between"><h3>${esc(project.id)}</h3><button class="btn" type="button" data-time-limits="remove-project" data-index="${index}" aria-label="Remove ${esc(project.id)}">Remove</button></div>${fields(`project-${index}`, project.stages)}</section>`,
        )
        .join("")
    : '<p class="sub">No project overrides.</p>';
  const projectError = view.fieldErrors["new-project"];
  return `<section class="settings-section">${intro}<form id="time-limit-form" class="col">
    ${fields("default", draft.default)}
    <h3>Projects</h3><p class="sub">Override a stage for one Linear project.</p>${projects}
    <div class="settings-add"><label for="time-new-project">Project</label><input id="time-new-project" name="time-new-project" value="${esc(view.projectDraft ?? "")}" placeholder="Linear project id" autocapitalize="none" spellcheck="false"${projectError ? ' aria-invalid="true" aria-describedby="time-new-project-error"' : ""}>${projectError ? `<p class="time-limit-error" id="time-new-project-error" role="alert">${esc(projectError)}</p>` : ""}<div class="row"><button class="btn" type="button" data-time-limits="add-project">Add project</button></div></div>
    ${feedback}<div class="row"><button class="btn" type="submit" ${view.busy ? "disabled" : ""}>Save time limits</button></div></form></section>`;
}

async function timeLimitRequest(engine: string, body?: unknown): Promise<TimeLimitSettings> {
  const response = await fetch(new URL(PATH, engine), {
    method: body ? "PUT" : "GET",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...(body
        ? { "Content-Type": "application/json", "x-paws-csrf": readCsrfToken(document) }
        : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch((error) => {
    journalCaught(error, "time-limit-settings.timeLimitRequest.json", null);
    return {};
  });
  if (!response.ok)
    throw new Error(
      typeof data.error === "string" ? data.error : `Request failed (${response.status}).`,
      { cause: response.status },
    );
  return data as TimeLimitSettings;
}

export function createTimeLimitSettings(): {
  mount(root: HTMLElement, engine: string | null): void;
} {
  let root: HTMLElement | null = null;
  let engine: string | null = null;
  let generation = 0;
  const fresh = (): TimeLimitView => ({
    draft: null,
    busy: null,
    error: null,
    saved: false,
    fieldErrors: {},
  });
  let view = fresh();
  const paint = () => {
    if (root) renderMarkup(root, renderTimeLimitSettings(view));
  };
  const run = async (busy: string, body?: unknown) => {
    if (!engine) return;
    const started = generation;
    Object.assign(view, { busy, error: null, saved: false });
    paint();
    try {
      const data = await timeLimitRequest(engine, body);
      if (started !== generation) return;
      Object.assign(view, {
        draft: timeLimitDraft(data),
        denied: false,
        saved: body !== undefined,
      });
    } catch (error) {
      journalCaught(error, "time-limit-settings.createTimeLimitSettings.request", null);
      if (started !== generation) return;
      if (error instanceof Error && error.cause === 403 && !body) view.denied = true;
      else view.error = error instanceof Error ? error.message : "Could not save time limits.";
    }
    view.busy = null;
    paint();
  };
  const readForm = () => {
    const draft = view.draft;
    if (!root || !draft) return;
    const value = (name: string) =>
      root?.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`)?.value;
    const scopes: [string, StageDraft][] = [
      ["default", draft.default],
      ...draft.projects.map((project, index): [string, StageDraft] => [
        `project-${index}`,
        project.stages,
      ]),
    ];
    for (const [scope, stages] of scopes)
      for (const stage of TIME_STAGES) {
        const id = `time-${scope}-${stage}`;
        stages[stage] = {
          mode: (value(`${id}-mode`) as Mode | undefined) ?? stages[stage].mode,
          minutes: value(id) ?? stages[stage].minutes,
        };
      }
    view.projectDraft = value("time-new-project") ?? "";
  };
  const change = (event: Event) => {
    if (!(event.target as Element).closest("#time-limit-form")) return;
    readForm();
    view.saved = false;
    if ((event.target as HTMLElement).tagName === "SELECT") paint();
  };
  const click = (event: Event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-time-limits]");
    if (!button || view.busy) return;
    const action = button.dataset.timeLimits;
    if (action === "reload") return void run("Loading time limits…");
    readForm();
    const draft = view.draft;
    if (!draft) return;
    if (action === "remove-project") draft.projects.splice(Number(button.dataset.index), 1);
    if (action === "add-project") {
      const id = view.projectDraft?.trim() ?? "";
      const problem = !PROJECT_ID.test(id)
        ? "Enter a Linear project id."
        : draft.projects.some((project) => project.id === id)
          ? "This project already has an override."
          : null;
      view.fieldErrors = problem ? { "new-project": problem } : {};
      if (!problem) {
        draft.projects.push({ id, stages: stagesDraft({}, true) });
        view.projectDraft = "";
      }
    }
    view.saved = false;
    paint();
  };
  const submit = (event: Event) => {
    if ((event.target as Element).id !== "time-limit-form") return;
    event.preventDefault();
    readForm();
    if (!view.draft || view.busy) return;
    const result = timeLimitBody(view.draft);
    if ("errors" in result) {
      view.fieldErrors = result.errors;
      view.saved = false;
      return paint();
    }
    view.fieldErrors = {};
    void run("Saving time limits…", result.body);
  };
  return {
    mount(next, nextEngine) {
      if (root === next && engine === nextEngine) return;
      root?.removeEventListener("click", click);
      root?.removeEventListener("change", change);
      root?.removeEventListener("submit", submit);
      if (engine !== nextEngine) {
        generation += 1;
        view = fresh();
      }
      root = next;
      engine = nextEngine;
      root.addEventListener("click", click);
      root.addEventListener("change", change);
      root.addEventListener("submit", submit);
      if (!engine) {
        view.error = "Connect to your Paws dashboard to manage time limits.";
        paint();
      } else if (!view.draft && !view.busy && !view.denied) void run("Loading time limits…");
      else paint();
    },
  };
}
