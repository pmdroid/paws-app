import { z } from "zod";
import { saveSettingsSections, type ImplementerName, type PawsConfigFile } from "./file";
import { mergeSection, type StoredMerge } from "./merge";
import { queueSection, type QueueSettings } from "./queue";

export type AgentProfile = {
  agent: ImplementerName;
  model: string | null;
  effort?: string;
  fast?: boolean;
};
export type AgentProfiles = {
  implementer: AgentProfile;
  reviewer: AgentProfile;
  reviewerFallback?: AgentProfile;
};
export type AgentPreset = { implementer: AgentProfile; reviewer: AgentProfile };
export type AgentSettings = {
  defaults: AgentProfiles;
  presets?: Record<string, AgentPreset>;
};

const profileSchema = z.strictObject({
  agent: z.enum(["claude", "grok", "codex", "opencode"]),
  model: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine(
      (value) =>
        !/\s/.test(value) &&
        [...value].every((char) => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127),
    )
    .nullable(),
  effort: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9_-]+$/)
    .optional(),
  fast: z.boolean().optional(),
});
const settingsSchema = z.strictObject({
  defaults: z.strictObject({
    implementer: profileSchema,
    reviewer: profileSchema,
    reviewerFallback: profileSchema.optional(),
  }),
  presets: z
    .record(
      z
        .string()
        .refine(
          (name) =>
            name.trim().length >= 1 && name.trim().length <= 40 && /^[a-zA-Z0-9 ._-]+$/.test(name),
        ),
      z.strictObject({ implementer: profileSchema, reviewer: profileSchema }),
    )
    .optional(),
});

export function parseAgentSettings(value: unknown): AgentSettings {
  const settings = settingsSchema.parse(value);
  const names = new Set<string>();
  for (const name of Object.keys(settings.presets ?? {})) {
    const key = name.trim().toLowerCase();
    if (names.has(key)) throw new Error(`Duplicate preset: ${name}`);
    names.add(key);
  }
  for (const [name, preset] of Object.entries(settings.presets ?? {})) {
    try {
      validateIndependence(preset);
    } catch (error) {
      throw new Error(`Preset ${name}: ${(error as Error).message}`, { cause: error });
    }
  }
  validateIndependence(settings.defaults);
  if (settings.defaults.reviewerFallback?.agent === settings.defaults.reviewer.agent)
    throw new Error("The reviewer fallback must use a different agent than the reviewer");
  return settings;
}

const REVIEW_PATHS: Partial<Record<ImplementerName, "review command" | "ACP reviewer">> = {
  claude: "review command",
  codex: "review command",
  grok: "ACP reviewer",
  opencode: "ACP reviewer",
};

function validateIndependence(profiles: AgentProfiles): void {
  for (const reviewer of [profiles.reviewer, profiles.reviewerFallback])
    if (reviewer && REVIEW_PATHS[reviewer.agent] === undefined)
      throw new Error(`Paws has no review path for ${reviewer.agent}; choose another reviewer`);
  if (
    profiles.implementer.agent === profiles.reviewer.agent &&
    profiles.implementer.model === profiles.reviewer.model
  ) {
    throw new Error("Implementer and reviewer must use different agents or different models");
  }
  const fallback = profiles.reviewerFallback;
  if (
    fallback &&
    fallback.agent === profiles.implementer.agent &&
    fallback.model === profiles.implementer.model
  )
    throw new Error(
      "Implementer and reviewer fallback must use different agents or different models",
    );
}

export function readAgentSettings(config: PawsConfigFile): AgentSettings {
  return structuredClone(
    config.agentSettings ?? {
      defaults: {
        implementer: { agent: config.agents.implementer, model: null },
        reviewer: { agent: "codex", model: null },
      },
    },
  );
}

export type AgentLabelProblem = {
  role: "implementer" | "reviewer";
  label: string;
  reason: "unknown_preset" | "conflicting_presets";
};

export function resolveAgentProfiles(
  config: PawsConfigFile,
  labels?: { implementer?: string; reviewer?: string },
): AgentProfiles & { labelProblems?: AgentLabelProblem[] } {
  const settings = readAgentSettings(config);
  const labelProblems: AgentLabelProblem[] = [];
  const key = (name: string) => name.trim().toLowerCase();
  const found: { role: "implementer" | "reviewer"; label: string; name: string }[] = [];
  for (const role of ["implementer", "reviewer"] as const) {
    const label = labels?.[role];
    if (label === undefined) continue;
    const name = Object.keys(settings.presets ?? {}).find((preset) => key(preset) === key(label));
    if (name === undefined) labelProblems.push({ role, label, reason: "unknown_preset" });
    else found.push({ role, label, name });
  }
  let { implementer, reviewer } = settings.defaults;
  if (new Set(found.map((entry) => key(entry.name))).size > 1)
    for (const { role, label } of found)
      labelProblems.push({ role, label, reason: "conflicting_presets" });
  else if (found[0] && labelProblems.length === 0)
    ({ implementer, reviewer } = settings.presets![found[0].name]!);
  const fallback = settings.defaults.reviewerFallback;
  return {
    implementer,
    ...(labels === undefined ? {} : { labelProblems }),
    reviewer,
    ...(fallback &&
    fallback.agent !== reviewer.agent &&
    (fallback.agent !== implementer.agent || fallback.model !== implementer.model)
      ? { reviewerFallback: fallback }
      : {}),
  };
}

export function parseAgentSettingsSection(
  section: unknown,
  implementer: ImplementerName,
): AgentSettings | null {
  const agents = section as
    | {
        defaults?: {
          implementer?: Partial<AgentProfile>;
          reviewer?: Partial<AgentProfile>;
          reviewer_fallback?: Partial<AgentProfile>;
        };
        presets?: Record<string, Partial<Record<keyof AgentPreset, object>>>;
      }
    | undefined;
  if (agents?.defaults === undefined && agents?.presets === undefined) return null;
  const defaults = {
    implementer: { model: null, ...(agents?.defaults?.implementer ?? { agent: implementer }) },
    reviewer: { model: null, ...(agents?.defaults?.reviewer ?? { agent: "codex" }) },
    ...(agents?.defaults?.reviewer_fallback
      ? { reviewerFallback: { model: null, ...agents.defaults.reviewer_fallback } }
      : {}),
  };
  return parseAgentSettings({
    defaults,
    ...(agents?.presets === undefined
      ? {}
      : {
          presets: Object.fromEntries(
            Object.entries(agents.presets).map(([name, preset]) => [
              name,
              {
                implementer: { model: null, ...preset.implementer },
                reviewer: { model: null, ...preset.reviewer },
              },
            ]),
          ),
        }),
  });
}

export function agentsSection(current: unknown, input: AgentSettings): Record<string, unknown> {
  const settings = parseAgentSettings(input);
  const {
    defaults: _defaults,
    presets: _presets,
    ...rest
  } = (typeof current === "object" && current !== null ? current : {}) as Record<string, unknown>;
  const fallback = settings.defaults.reviewerFallback;
  return {
    ...rest,
    implementer: settings.defaults.implementer.agent,
    defaults: {
      implementer: profileSection(settings.defaults.implementer),
      reviewer: profileSection(settings.defaults.reviewer),
      ...(fallback ? { reviewer_fallback: profileSection(fallback) } : {}),
    },
    ...(settings.presets && Object.keys(settings.presets).length > 0
      ? {
          presets: Object.fromEntries(
            Object.entries(settings.presets).map(([name, preset]) => [
              name,
              {
                implementer: profileSection(preset.implementer),
                reviewer: profileSection(preset.reviewer),
              },
            ]),
          ),
        }
      : {}),
  };
}

export function writeAgentSettings(
  path: string,
  input: AgentSettings,
  merge?: StoredMerge,
  queue?: QueueSettings,
): Promise<void> {
  return saveSettingsSections(path, (stored) => ({
    agents: agentsSection(stored["agents"], input),
    ...(merge === undefined ? {} : { merge: mergeSection(merge) }),
    ...(queue === undefined ? {} : { queue: queueSection(queue) }),
  }));
}

function profileSection(profile: AgentProfile): Record<string, unknown> {
  return {
    agent: profile.agent,
    ...(profile.model === null ? {} : { model: profile.model }),
    ...(profile.effort === undefined ? {} : { effort: profile.effort }),
    ...(profile.fast === undefined ? {} : { fast: profile.fast }),
  };
}
