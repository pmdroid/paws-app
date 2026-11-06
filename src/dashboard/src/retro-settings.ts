import type { AgentModelCatalog } from "./agent-settings";

export const RETRO_SETTINGS_API_PATH = "/api/retros/settings";
export const RETRO_PREVIEW_API_PATH = "/api/retros/preview";
export const RETRO_MODELS_API_PATH = "/api/runners/models";
export const retroFrozenSettingsPath = (retroId: string) =>
  `/api/retros/reports/${encodeURIComponent(retroId)}/settings`;
export const retroRenderedPromptPath = (retroId: string) =>
  `/api/retros/reports/${encodeURIComponent(retroId)}/prompt`;

export type RetroWeekday =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

export type RetroSettingsDraft = {
  prompt: string;
  agentProfile: {
    agent: "claude" | "codex" | "grok" | "opencode";
    model: string | null;
    effort: string | null;
  };
  repositories: string[];
  outputLimits: { maxItems: number; workedWell: number };
  executionLimits: { activeMinutes: number; retries: number };
  schedule: { cadence: "weekly" | "paused"; weekday: RetroWeekday; time: string; timeZone: string };
};

export type RetroSettingsProblem = { field: string; message: string };

export const RETRO_PROMPT_VARIABLES = [
  "period",
  "repositories",
  "max_items",
  "worked_well",
  "digest",
] as const;
export const RETRO_PROMPT_MAX_CHARS = 16_000;

export const RETRO_AGENT_NAMES = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok",
  opencode: "OpenCode",
} as const;

export const RETRO_WEEKDAY_NAMES: Record<RetroWeekday, string> = {
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
  sunday: "Sunday",
};

type Bounds = { min: number; max: number };
export type RetroSettingsView = {
  revision: number;
  saved: boolean;
  settings: RetroSettingsDraft;
  createdBy: string | null;
  createdAt: number | null;
  defaultPrompt: string;
  accessibleRepositories: string[];
  inaccessibleRepositories: string[];
  limits: {
    maxItems: Bounds;
    workedWell: Bounds;
    activeMinutes: Bounds;
    retries: Bounds;
  };
  canEdit: boolean;
};

export type RetroPreview = { text: string; label: string; sha256: string };

export type RetroFrozenSettings = {
  retroId: string;
  settingsRevision: number;
  origin: "scheduled" | "manual";
  createdAt: number;
  prompt: string;
  agentProfile: { agent: string; model?: string | null; effort?: string | null };
  repositories: string[];
  outputLimits: { maxItems?: number; workedWell?: number };
  executionLimits: { activeMinutes?: number; retries?: number };
  renderedPrompt: boolean;
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseRetroSettingsView(body: unknown): RetroSettingsView | null {
  if (!record(body) || !record(body.settings) || !record(body.limits)) return null;
  const settings = body.settings;
  if (
    typeof body.revision !== "number" ||
    typeof body.canEdit !== "boolean" ||
    typeof body.defaultPrompt !== "string" ||
    !Array.isArray(body.accessibleRepositories) ||
    typeof settings.prompt !== "string" ||
    !record(settings.agentProfile) ||
    !Array.isArray(settings.repositories) ||
    !record(settings.outputLimits) ||
    !record(settings.executionLimits) ||
    !record(settings.schedule)
  )
    return null;
  return {
    ...(body as RetroSettingsView),
    inaccessibleRepositories: Array.isArray(body.inaccessibleRepositories)
      ? (body.inaccessibleRepositories as string[])
      : [],
  };
}

export function parseRetroPreview(body: unknown): RetroPreview | null {
  return record(body) && typeof body.text === "string" && typeof body.label === "string"
    ? { text: body.text, label: body.label, sha256: String(body.sha256 ?? "") }
    : null;
}

export function parseRetroFrozenSettings(body: unknown): RetroFrozenSettings | null {
  return record(body) &&
    typeof body.retroId === "string" &&
    typeof body.prompt === "string" &&
    typeof body.settingsRevision === "number" &&
    record(body.agentProfile)
    ? (body as RetroFrozenSettings)
    : null;
}

const TOKEN = /{{\s*([^{}]*?)\s*}}/g;

export function retroPromptProblem(prompt: string): string | null {
  if (prompt.trim().length === 0) return "Enter the instructions Paws should use.";
  if (prompt.length > RETRO_PROMPT_MAX_CHARS)
    return `Keep the prompt under ${RETRO_PROMPT_MAX_CHARS.toLocaleString("en-US")} characters.`;
  const matches = [...prompt.matchAll(TOKEN)];
  const names = matches.map((match) => match[1]!);
  if (names.includes("")) return "Name each variable between its double braces.";
  const unknown = [...new Set(names)].filter(
    (name) => !(RETRO_PROMPT_VARIABLES as readonly string[]).includes(name),
  );
  if (unknown.length > 0) return `Unknown variable: ${unknown.join(", ")}.`;
  if (names.filter((name) => name === "digest").length !== 1)
    return "Include {{digest}} exactly once so the retro has its source evidence.";
  const touchesBrace = matches.some((match) => {
    const end = match.index + match[0].length;
    return prompt[match.index - 1] === "{" || prompt[end] === "}";
  });
  const rest = prompt.replace(TOKEN, "");
  if (touchesBrace || rest.includes("{{") || rest.includes("}}"))
    return "Close each variable with matching double braces.";
  return null;
}

export function insertRetroVariable(
  value: string,
  start: number,
  end: number,
  name: string,
): { value: string; cursor: number } {
  const token = `{{${name}}}`;
  const from = Math.max(0, Math.min(start, value.length));
  const to = Math.max(from, Math.min(end, value.length));
  return { value: value.slice(0, from) + token + value.slice(to), cursor: from + token.length };
}

type Choice = { id: string; name: string };
export type RetroChoiceState = "ok" | "default" | "loading" | "unavailable";

export function retroProfileChoices(
  profile: RetroSettingsDraft["agentProfile"],
  catalogs: readonly AgentModelCatalog[] | null,
): {
  models: Choice[] | null;
  efforts: Choice[] | null;
  model: RetroChoiceState;
  effort: RetroChoiceState;
} {
  if (catalogs === null)
    return {
      models: null,
      efforts: null,
      model: profile.model === null ? "default" : "loading",
      effort: profile.effort === null ? "default" : "loading",
    };
  const catalog = catalogs.find((entry) => entry.agent === profile.agent) ?? null;
  const models = catalog?.models.map(({ id, name }) => ({ id, name })) ?? [];
  const selected = catalog?.models.find((entry) => entry.id === profile.model) ?? null;
  const efforts = (
    profile.model === null ? (catalog?.efforts ?? []) : (selected?.efforts ?? [])
  ).filter((entry) => !["default", "auto"].includes(entry.id));
  return {
    models,
    efforts,
    model: profile.model === null ? "default" : selected ? "ok" : "unavailable",
    effort:
      profile.effort === null
        ? "default"
        : efforts.some((entry) => entry.id === profile.effort)
          ? "ok"
          : "unavailable",
  };
}

export function compatibleRetroProfile(
  profile: RetroSettingsDraft["agentProfile"],
  catalogs: readonly AgentModelCatalog[] | null,
): RetroSettingsDraft["agentProfile"] {
  if (catalogs === null) return profile;
  const choices = retroProfileChoices(profile, catalogs);
  const model = choices.model === "unavailable" ? null : profile.model;
  const next = { ...profile, model };
  return retroProfileChoices(next, catalogs).effort === "unavailable"
    ? { ...next, effort: null }
    : next;
}

export function retroScheduleSummary(schedule: RetroSettingsDraft["schedule"]): string {
  return schedule.cadence === "paused"
    ? "Automatic retros are paused. The next retro runs only when someone selects Run retro."
    : `Every ${RETRO_WEEKDAY_NAMES[schedule.weekday] ?? schedule.weekday}, ${schedule.time} ${schedule.timeZone}.`;
}

export function sameRetroDraft(a: RetroSettingsDraft, b: RetroSettingsDraft): boolean {
  const key = (draft: RetroSettingsDraft) =>
    JSON.stringify({
      ...draft,
      repositories: [...draft.repositories].map((name) => name.toLowerCase()).sort(),
    });
  return key(a) === key(b);
}

export function retroTimeZones(current: string): string[] {
  const supported = (
    Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
  ).supportedValuesOf?.("timeZone") ?? ["UTC"];
  const zones = supported.includes("UTC") ? supported : ["UTC", ...supported];
  return zones.includes(current) ? zones : [current, ...zones];
}
