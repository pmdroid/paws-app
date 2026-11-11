import type { Database } from "bun:sqlite";
import {
  createRetroSteps,
  getRetroSteps,
  latestRetroSettingsRevisionSteps,
  retroIdForWindowSteps,
  saveRetroSettingsRevisionSteps,
  settled,
  sqliteDb,
  type Q,
  type Retro,
  type Steps,
  type RetroOrigin,
  type RetroSettingsRevision,
} from "../db";
import type { AgentModelCatalog } from "../runner-models";
import { DEFAULT_RETRO_PROMPT, RETRO_PROMPT_MAX_CHARS, retroPromptProblem } from "./prompt";

export const RETRO_AGENTS = ["claude", "codex", "grok", "opencode"] as const;
export type RetroAgent = (typeof RETRO_AGENTS)[number];
export const RETRO_WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;
export type RetroWeekday = (typeof RETRO_WEEKDAYS)[number];

export type RetroAgentProfile = { agent: RetroAgent; model: string | null; effort: string | null };
export type RetroOutputLimits = { maxItems: number; workedWell: number };
export type RetroExecutionLimits = { activeMinutes: number; retries: number };
export type RetroSchedule = {
  cadence: "weekly" | "paused";
  weekday: RetroWeekday;
  time: string;
  timeZone: string;
};
export type RetroSettingsDraft = {
  prompt: string;
  agentProfile: RetroAgentProfile;
  repositories: string[];
  outputLimits: RetroOutputLimits;
  executionLimits: RetroExecutionLimits;
  schedule: RetroSchedule;
};
export type ResolvedRetroProfile = {
  agent: RetroAgent;
  model: string;
  effort: string | null;
  selected: { model: string | null; effort: string | null };
};

export const RETRO_LIMITS = {
  prompt: { max: RETRO_PROMPT_MAX_CHARS },
  maxItems: { min: 1, max: 5 },
  workedWell: { min: 0, max: 3 },
  activeMinutes: { min: 1, max: 120 },
  retries: { min: 0, max: 3 },
  repositories: { min: 1, max: 64 },
} as const;

export function proposedRetroSettings(
  accessibleRepositories: readonly string[],
): RetroSettingsDraft {
  return {
    prompt: DEFAULT_RETRO_PROMPT,
    agentProfile: { agent: "codex", model: null, effort: null },
    repositories: [...accessibleRepositories],
    outputLimits: { maxItems: 5, workedWell: 3 },
    executionLimits: { activeMinutes: 15, retries: 1 },
    schedule: { cadence: "weekly", weekday: "monday", time: "09:00", timeZone: "UTC" },
  };
}

export type RetroSettingsProblem = { field: string; message: string };
export type RetroProfileCheck =
  | { ok: true; profile: RetroAgentProfile }
  | {
      ok: false;
      reason: "catalog_unavailable" | "unsupported";
      problem: RetroSettingsProblem;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const integerIn = (value: unknown, bounds: { min: number; max: number }): value is number =>
  Number.isInteger(value) && (value as number) >= bounds.min && (value as number) <= bounds.max;
const choice = (value: unknown) =>
  value === null || value === undefined || value === ""
    ? null
    : typeof value === "string" && /^[A-Za-z0-9._:[\]/-]{1,200}$/.test(value)
      ? value
      : undefined;

export function validRetroTimeZone(timeZone: string): boolean {
  if (timeZone.length === 0 || timeZone.length > 64) return false;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone.length > 0;
  } catch {
    return false;
  }
}

export function parseRetroSettingsDraft(
  value: unknown,
): { ok: true; draft: RetroSettingsDraft } | { ok: false; problems: RetroSettingsProblem[] } {
  const problems: RetroSettingsProblem[] = [];
  const problem = (field: string, message: string) => problems.push({ field, message });
  if (!isRecord(value)) return { ok: false, problems: [{ field: "", message: "Send settings." }] };
  const prompt = typeof value.prompt === "string" ? value.prompt : "";
  const promptProblem = retroPromptProblem(prompt);
  if (promptProblem) problem("prompt", promptProblem);

  const profile = isRecord(value.agentProfile) ? value.agentProfile : {};
  const agent = (RETRO_AGENTS as readonly unknown[]).includes(profile.agent)
    ? (profile.agent as RetroAgent)
    : null;
  if (agent === null) problem("agentProfile.agent", "Choose a supported agent.");
  const model = choice(profile.model);
  if (model === undefined) problem("agentProfile.model", "Choose a model from the catalog.");
  const effort = choice(profile.effort);
  if (effort === undefined) problem("agentProfile.effort", "Choose an effort from the catalog.");

  const repositories = Array.isArray(value.repositories) ? value.repositories : null;
  const names =
    repositories?.filter(
      (name): name is string =>
        typeof name === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name),
    ) ?? [];
  const unique = [...new Map(names.map((name) => [name.toLowerCase(), name])).values()];
  if (repositories === null || names.length !== repositories.length)
    problem("repositories", "Send repositories as owner/repo names.");
  else if (!integerIn(unique.length, RETRO_LIMITS.repositories))
    problem("repositories", "Select at least one repository.");

  const output = isRecord(value.outputLimits) ? value.outputLimits : {};
  if (!integerIn(output.maxItems, RETRO_LIMITS.maxItems))
    problem("outputLimits.maxItems", "Maximum patterns is a whole number from 1 to 5.");
  if (!integerIn(output.workedWell, RETRO_LIMITS.workedWell))
    problem("outputLimits.workedWell", "Worked well observations is a whole number from 0 to 3.");

  const execution = isRecord(value.executionLimits) ? value.executionLimits : {};
  if (!integerIn(execution.activeMinutes, RETRO_LIMITS.activeMinutes))
    problem("executionLimits.activeMinutes", "The time limit is 1 to 120 minutes.");
  if (!integerIn(execution.retries, RETRO_LIMITS.retries))
    problem("executionLimits.retries", "Generation retries is a whole number from 0 to 3.");

  const schedule = isRecord(value.schedule) ? value.schedule : {};
  if (schedule.cadence !== "weekly" && schedule.cadence !== "paused")
    problem("schedule.cadence", "Choose weekly or paused.");
  if (!(RETRO_WEEKDAYS as readonly unknown[]).includes(schedule.weekday))
    problem("schedule.weekday", "Choose a weekday.");
  if (typeof schedule.time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(schedule.time))
    problem("schedule.time", "Send the time as HH:MM.");
  if (typeof schedule.timeZone !== "string" || !validRetroTimeZone(schedule.timeZone))
    problem("schedule.timeZone", "Choose an IANA time zone.");

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    draft: {
      prompt,
      agentProfile: { agent: agent!, model: model!, effort: effort! },
      repositories: unique,
      outputLimits: {
        maxItems: output.maxItems as number,
        workedWell: output.workedWell as number,
      },
      executionLimits: {
        activeMinutes: execution.activeMinutes as number,
        retries: execution.retries as number,
      },
      schedule: {
        cadence: schedule.cadence as RetroSchedule["cadence"],
        weekday: schedule.weekday as RetroWeekday,
        time: schedule.time as string,
        timeZone: schedule.timeZone as string,
      },
    },
  };
}

export function checkRetroProfile(
  profile: RetroAgentProfile,
  catalogs: readonly AgentModelCatalog[] | null,
  previousAgent?: RetroAgent,
): RetroProfileCheck {
  const catalog = catalogs?.find((entry) => entry.agent === profile.agent) ?? null;
  let { model, effort } = profile;
  if (previousAgent !== undefined && previousAgent !== profile.agent) {
    const offered = catalog?.models.find((entry) => entry.id === model);
    if (!offered) model = null;
    const efforts = offered ? offered.efforts : (catalog?.efforts ?? null);
    if (!efforts?.some((entry) => entry.id === effort)) effort = null;
  }
  const checked = { agent: profile.agent, model, effort };
  if (model === null && effort === null) return { ok: true, profile: checked };
  const unavailable = (field: string): RetroProfileCheck => ({
    ok: false,
    reason: "catalog_unavailable",
    problem: {
      field,
      message: `No signed-in runner has reported ${profile.agent}'s choices yet. Sign in a runner, or use the agent default.`,
    },
  });
  if (catalog === null)
    return unavailable(model === null ? "agentProfile.effort" : "agentProfile.model");
  const entry = model === null ? null : catalog.models.find((candidate) => candidate.id === model);
  if (model !== null && !entry)
    return {
      ok: false,
      reason: "unsupported",
      problem: {
        field: "agentProfile.model",
        message: `${profile.agent} does not offer ${model}.`,
      },
    };
  if (effort === null) return { ok: true, profile: checked };
  const efforts = entry ? entry.efforts : catalog.efforts;
  if (efforts === null) return unavailable("agentProfile.effort");
  if (!efforts.some((candidate) => candidate.id === effort))
    return {
      ok: false,
      reason: "unsupported",
      problem: {
        field: "agentProfile.effort",
        message: `${model ?? profile.agent} does not offer ${effort} effort.`,
      },
    };
  return { ok: true, profile: checked };
}

export function resolveRetroProfile(
  profile: RetroAgentProfile,
  catalogs: readonly AgentModelCatalog[] | null,
):
  | { ok: true; profile: ResolvedRetroProfile }
  | { ok: false; reason: "catalog_unavailable" | "unsupported"; problem: RetroSettingsProblem } {
  const checked = checkRetroProfile(profile, catalogs);
  if (!checked.ok) return checked;
  const catalog = catalogs?.find((entry) => entry.agent === profile.agent) ?? null;
  const model = profile.model ?? catalog?.defaultModel ?? null;
  const entry = catalog?.models.find((candidate) => candidate.id === model);
  if (model === null || !entry)
    return {
      ok: false,
      reason: "catalog_unavailable",
      problem: {
        field: "agentProfile.model",
        message: `No signed-in runner has reported ${profile.agent}'s default model.`,
      },
    };
  const effort = profile.effort ?? entry.defaultEffort;
  if (effort === null && (entry.efforts === null || entry.efforts.length > 0))
    return {
      ok: false,
      reason: "catalog_unavailable",
      problem: {
        field: "agentProfile.effort",
        message: `No signed-in runner has reported ${model}'s default effort.`,
      },
    };
  return {
    ok: true,
    profile: {
      agent: profile.agent,
      model,
      effort,
      selected: { model: profile.model, effort: profile.effort },
    },
  };
}

export type RetroSettingsView = {
  revision: number;
  saved: boolean;
  settings: RetroSettingsDraft;
  createdBy: string | null;
  createdAt: number | null;
  defaultPrompt: string;
  accessibleRepositories: string[];
  inaccessibleRepositories: string[];
  limits: typeof RETRO_LIMITS;
};

function draftFromRevision(revision: RetroSettingsRevision): RetroSettingsDraft {
  return {
    prompt: revision.prompt,
    agentProfile: revision.agentProfile as RetroAgentProfile,
    repositories: revision.repositories,
    outputLimits: revision.outputLimits as RetroOutputLimits,
    executionLimits: revision.executionLimits as RetroExecutionLimits,
    schedule: revision.schedule as RetroSchedule,
  };
}

export function readRetroSettings(
  db: Database,
  input: { workspaceId: string; accessibleRepositories: readonly string[] },
): Promise<RetroSettingsView> {
  return sqliteDb(db).run((q) => readRetroSettingsSteps(q, input));
}

function* readRetroSettingsSteps(
  q: Q,
  input: { workspaceId: string; accessibleRepositories: readonly string[] },
): Steps<RetroSettingsView> {
  const latest = yield* latestRetroSettingsRevisionSteps(q, input.workspaceId);
  const settings = latest
    ? draftFromRevision(latest)
    : proposedRetroSettings(input.accessibleRepositories);
  const accessible = new Set(input.accessibleRepositories.map((name) => name.toLowerCase()));
  return {
    revision: latest?.revision ?? 0,
    saved: latest !== null,
    settings,
    createdBy: latest?.createdBy ?? null,
    createdAt: latest?.createdAt ?? null,
    defaultPrompt: DEFAULT_RETRO_PROMPT,
    accessibleRepositories: [...input.accessibleRepositories],
    inaccessibleRepositories: settings.repositories.filter(
      (name) => !accessible.has(name.toLowerCase()),
    ),
    limits: RETRO_LIMITS,
  };
}

export type RetroSettingsSave =
  | { ok: true; view: RetroSettingsView }
  | { ok: false; reason: "conflict"; current: RetroSettingsView; draft: unknown }
  | {
      ok: false;
      reason: "invalid" | "unsupported" | "catalog_unavailable" | "inaccessible_repository";
      problems: RetroSettingsProblem[];
      draft: unknown;
    };

export async function saveRetroSettings(
  db: Database,
  input: {
    workspaceId: string;
    actorId: string;
    expectedRevision: number;
    draft: unknown;
    catalogs: readonly AgentModelCatalog[] | null;
    accessibleRepositories: readonly string[];
    now: number;
    keepSavedProfile?: boolean;
  },
): Promise<RetroSettingsSave> {
  const read = (q: Q) => readRetroSettingsSteps(q, input);
  const parsed = parseRetroSettingsDraft(input.draft);
  if (!parsed.ok)
    return { ok: false, reason: "invalid", problems: parsed.problems, draft: input.draft };
  const draft = parsed.draft;
  const accessible = new Map(
    input.accessibleRepositories.map((name) => [name.toLowerCase(), name]),
  );
  const inaccessible = draft.repositories.filter((name) => !accessible.has(name.toLowerCase()));
  if (inaccessible.length > 0)
    return {
      ok: false,
      reason: "inaccessible_repository",
      problems: [
        { field: "repositories", message: `Paws cannot access ${inaccessible.join(", ")}.` },
      ],
      draft: input.draft,
    };
  draft.repositories = draft.repositories.map((name) => accessible.get(name.toLowerCase())!);
  return sqliteDb(db).transaction(function* (q): Steps<RetroSettingsSave> {
    const latest = yield* latestRetroSettingsRevisionSteps(q, input.workspaceId);
    if ((latest?.revision ?? 0) !== input.expectedRevision)
      return { ok: false, reason: "conflict", current: yield* read(q), draft: input.draft };
    const saved = latest?.agentProfile as RetroAgentProfile | undefined;
    const unchanged =
      input.keepSavedProfile === true &&
      saved !== undefined &&
      saved.agent === draft.agentProfile.agent &&
      saved.model === draft.agentProfile.model &&
      saved.effort === draft.agentProfile.effort;
    const profile: RetroProfileCheck = unchanged
      ? { ok: true, profile: draft.agentProfile }
      : checkRetroProfile(draft.agentProfile, input.catalogs, saved?.agent);
    if (!profile.ok)
      return { ok: false, reason: profile.reason, problems: [profile.problem], draft: input.draft };
    yield* saveRetroSettingsRevisionSteps(q, {
      ...draft,
      agentProfile: profile.profile,
      workspaceId: input.workspaceId,
      createdBy: input.actorId,
      now: input.now,
    });
    return { ok: true, view: yield* read(q) };
  });
}

export type RetroRunFreeze =
  | { ok: true; retro: Retro; created: boolean }
  | {
      ok: false;
      reason: "no_settings" | "no_accessible_repository" | "catalog_unavailable" | "unsupported";
      message: string;
    };

type FreezeInput = {
  id: string;
  workspaceId: string;
  windowStart: number;
  windowEnd: number;
  origin: RetroOrigin;
  scheduledFor?: number;
  catalogs: readonly AgentModelCatalog[] | null;
  accessibleRepositories: readonly string[];
  now: number;
};

export function* freezeRetroRunSteps(q: Q, input: FreezeInput): Steps<RetroRunFreeze> {
  const existing = yield* retroIdForWindowSteps(
    q,
    input.workspaceId,
    input.windowStart,
    input.windowEnd,
  );
  if (existing !== null)
    return { ok: true, retro: (yield* getRetroSteps(q, existing))!, created: false };
  const latest = yield* latestRetroSettingsRevisionSteps(q, input.workspaceId);
  if (latest === null)
    return { ok: false, reason: "no_settings", message: "Save retro settings first." };
  const repositories = retroRunRepositories(latest.repositories, input.accessibleRepositories);
  if (repositories.length === 0)
    return {
      ok: false,
      reason: "no_accessible_repository",
      message: "None of the selected repositories is accessible.",
    };
  const resolved = resolveRetroProfile(latest.agentProfile as RetroAgentProfile, input.catalogs);
  if (!resolved.ok)
    return { ok: false, reason: resolved.reason, message: resolved.problem.message };
  const frozen = yield* createRetroSteps(q, {
    id: input.id,
    workspaceId: input.workspaceId,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    origin: input.origin,
    ...(input.scheduledFor === undefined ? {} : { scheduledFor: input.scheduledFor }),
    settingsRevision: latest.revision,
    agentProfile: resolved.profile,
    repositories,
    now: input.now,
  });
  return { ok: true, ...frozen };
}

export function freezeRetroRun(db: Database, input: FreezeInput): RetroRunFreeze {
  return settled(sqliteDb(db).transaction((q) => freezeRetroRunSteps(q, input)));
}

export function retroRunRepositories(
  frozen: readonly string[],
  accessible: readonly string[],
): string[] {
  const now = new Set(accessible.map((name) => name.toLowerCase()));
  return frozen.filter((name) => now.has(name.toLowerCase()));
}

export function retroAttemptLimits(limits: Record<string, unknown>): {
  maxAttempts: number;
  activeExecutionMs: number;
} {
  const { activeMinutes, retries } = limits as RetroExecutionLimits;
  return { maxAttempts: retries + 1, activeExecutionMs: activeMinutes * 60_000 };
}
