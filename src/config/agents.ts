import { existsSync, readFileSync } from "node:fs";
import { readConfigText, updateConfigText } from "./settings-store";
import { z } from "zod";
import { setImplementerText, type ImplementerName, type PawsConfigFile } from "./file";
import { setMergeSettingsText, type StoredMerge } from "./merge";
import { setQueueSettingsText, type QueueSettings } from "./queue";

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
const retiredAccounts = z.unknown().optional();
const settingsSchema = z.strictObject({
  defaults: z.strictObject({
    implementer: profileSchema,
    reviewer: profileSchema,
    reviewerFallback: profileSchema.optional(),
    accounts: retiredAccounts,
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
  return parseSettings(value, false);
}

function parseSettings(value: unknown, legacyDefaults: boolean): AgentSettings {
  const settings = dropAccounts(settingsSchema.parse(value));
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
  // Presets alone must not newly validate the synthesized legacy role pair.
  if (legacyDefaults) return settings;
  validateIndependence(settings.defaults);
  if (settings.defaults.reviewerFallback?.agent === settings.defaults.reviewer.agent)
    throw new Error("The reviewer fallback must use a different agent than the reviewer");
  return settings;
}

function dropAccounts(settings: z.infer<typeof settingsSchema>): AgentSettings {
  const { accounts: _defaults, ...defaults } = settings.defaults;
  return {
    defaults,
    ...(settings.presets === undefined ? {} : { presets: settings.presets }),
  };
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

export function parseAgentSettingsToml(
  text: string,
  implementer: ImplementerName,
): AgentSettings | null {
  if (!/^\s*\[agents\.(defaults|presets)(?:[.\]])/m.test(text)) return null;
  const parsed = Bun.TOML.parse(text) as {
    agents?: {
      defaults?: {
        implementer?: Partial<AgentProfile>;
        reviewer?: Partial<AgentProfile>;
        reviewer_fallback?: Partial<AgentProfile>;
      };
      presets?: Record<string, Partial<AgentProfile> & Partial<Record<keyof AgentPreset, object>>>;
    };
  };
  const agents = parsed.agents;
  const defaults = {
    implementer: { model: null, ...(agents?.defaults?.implementer ?? { agent: implementer }) },
    reviewer: { model: null, ...(agents?.defaults?.reviewer ?? { agent: "codex" }) },
    ...(agents?.defaults?.reviewer_fallback
      ? { reviewerFallback: { model: null, ...agents.defaults.reviewer_fallback } }
      : {}),
  };
  return parseSettings(
    {
      defaults,
      ...(agents?.presets === undefined
        ? {}
        : {
            presets: Object.fromEntries(
              Object.entries(agents.presets).map(([name, preset]) => [
                name,
                "implementer" in preset || "reviewer" in preset
                  ? {
                      implementer: { model: null, ...preset.implementer },
                      reviewer: { model: null, ...preset.reviewer },
                    }
                  : legacyPreset({ model: null, ...preset }, defaults),
              ]),
            ),
          }),
    },
    agents?.defaults === undefined,
  );
}

function legacyPreset(profile: unknown, defaults: Record<string, unknown>): unknown {
  const normal = (value: unknown) => {
    const parsed = profileSchema.safeParse(value);
    return parsed.success ? parsed.data : value;
  };
  const implementer = normal(profile);
  const pair = { implementer, reviewer: normal(defaults.reviewer) };
  try {
    validateIndependence(pair as AgentPreset);
    return pair;
  } catch {
    return defaults.reviewerFallback
      ? { implementer, reviewer: normal(defaults.reviewerFallback) }
      : pair;
  }
}

const RETIRED_AGENT_PROJECTS = "agents.projects is no longer supported; using the global profiles";

function hasRetiredAgentProjects(text: string): boolean {
  if (!/^\s*\[agents\.projects(?:[.\]])/m.test(text)) return false;
  const agents = (Bun.TOML.parse(text) as { agents?: { projects?: unknown } }).agents;
  return agents?.projects !== undefined;
}

export function journalRetiredAgentProjects(
  configPath: string,
  journal: (line: string) => void,
): void {
  const file = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  if (hasRetiredAgentProjects(file) || hasRetiredAgentProjects(readConfigText(configPath)))
    journal(RETIRED_AGENT_PROJECTS);
}

export function renderAgentSettingsText(current: string, input: AgentSettings): string {
  const settings = parseAgentSettings(input);
  let section = "";
  const retained = current
    .split(/\r?\n/)
    .filter((line) => {
      const heading = /^\s*\[\[?\s*([^[\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
      if (heading?.[1]) section = heading[1].trim();
      return !/^agents\.(defaults|projects|presets)(?:\.|$)/i.test(section);
    })
    .join("\n");
  const base = setImplementerText(retained, settings.defaults.implementer.agent).trimEnd();
  const sections = [
    renderProfile("agents.defaults.implementer", settings.defaults.implementer),
    renderProfile("agents.defaults.reviewer", settings.defaults.reviewer),
  ];
  if (settings.defaults.reviewerFallback)
    sections.push(
      renderProfile("agents.defaults.reviewer_fallback", settings.defaults.reviewerFallback),
    );
  const presets = renderAgentPresetsText(settings);
  if (presets) sections.push(presets);
  const next = `${base}\n\n${sections.join("\n\n")}\n`;
  Bun.TOML.parse(next);
  return next;
}

export function writeAgentSettings(
  path: string,
  input: AgentSettings,
  merge?: StoredMerge,
  queue?: QueueSettings,
): Promise<void> {
  return updateConfigText(path, (current) => {
    const agents = renderAgentSettingsText(current, input);
    const merged = merge === undefined ? agents : setMergeSettingsText(agents, merge);
    return queue === undefined ? merged : setQueueSettingsText(merged, queue);
  });
}

/** Render already-validated presets without materializing legacy role defaults. */
function renderAgentPresetsText(settings: AgentSettings): string {
  return Object.entries(settings.presets ?? {})
    .flatMap(([name, preset]) =>
      (["implementer", "reviewer"] as const).map((role) =>
        renderProfile(`agents.presets.${JSON.stringify(name)}.${role}`, preset[role]),
      ),
    )
    .join("\n\n");
}

function renderProfile(section: string, profile: AgentProfile): string {
  const lines = [`[${section}]`, `agent = ${JSON.stringify(profile.agent)}`];
  if (profile.model !== null) lines.push(`model = ${JSON.stringify(profile.model)}`);
  if (profile.effort !== undefined) lines.push(`effort = ${JSON.stringify(profile.effort)}`);
  if (profile.fast !== undefined) lines.push(`fast = ${profile.fast}`);
  return lines.join("\n");
}
