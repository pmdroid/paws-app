import { updateConfigText } from "./settings-store";
import { z } from "zod";
import { setImplementerText, type ImplementerName, type PawsConfigFile } from "./file";
import { setMergeSettingsText, type StoredMerge } from "./merge";
import { setQueueSettingsText, type QueueSettings } from "./queue";

export type AgentProfile = { agent: ImplementerName; model: string | null; effort?: string };
export type AgentProfiles = {
  implementer: AgentProfile;
  reviewer: AgentProfile;
  reviewerFallback?: AgentProfile;
};
export type ProjectAgentProfiles = {
  repo: string;
  implementer?: AgentProfile;
  reviewer?: AgentProfile;
};
export type AgentSettings = {
  defaults: AgentProfiles;
  projects: ProjectAgentProfiles[];
  presets?: Record<string, AgentProfile>;
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
});
const retiredAccounts = z.unknown().optional();
const projectSchema = z.strictObject({
  repo: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\/[a-zA-Z0-9_.-]+$/)
    .max(240)
    .transform((value) => value.toLowerCase()),
  implementer: profileSchema.optional(),
  reviewer: profileSchema.optional(),
  accounts: retiredAccounts,
});
const settingsSchema = z.strictObject({
  defaults: z.strictObject({
    implementer: profileSchema,
    reviewer: profileSchema,
    reviewerFallback: profileSchema.optional(),
    accounts: retiredAccounts,
  }),
  projects: z.array(projectSchema).max(200),
  presets: z
    .record(
      z
        .string()
        .refine(
          (name) =>
            name.trim().length >= 1 && name.trim().length <= 40 && /^[a-zA-Z0-9 ._-]+$/.test(name),
        ),
      profileSchema,
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
  // Presets alone must not newly validate the synthesized legacy role pair.
  if (legacyDefaults) return settings;
  const repos = new Set<string>();
  validateIndependence(settings.defaults);
  if (settings.defaults.reviewerFallback?.agent === settings.defaults.reviewer.agent)
    throw new Error("The reviewer fallback must use a different agent than the reviewer");
  for (const project of settings.projects) {
    if (repos.has(project.repo)) throw new Error(`Duplicate project: ${project.repo}`);
    repos.add(project.repo);
    validateIndependence({ ...settings.defaults, ...project });
  }
  return settings;
}

function dropAccounts(settings: z.infer<typeof settingsSchema>): AgentSettings {
  const { accounts: _defaults, ...defaults } = settings.defaults;
  return {
    defaults,
    ...(settings.presets === undefined ? {} : { presets: settings.presets }),
    projects: settings.projects.map(({ accounts: _project, ...project }) => project),
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
      projects: [],
    },
  );
}

export type AgentLabelProblem = {
  role: "implementer" | "reviewer";
  label: string;
  reason: "unknown_preset" | "same_as_implementer";
};

export function resolveAgentProfiles(
  config: PawsConfigFile,
  repo?: string,
  labels?: { implementer?: string; reviewer?: string },
): AgentProfiles & { labelProblems?: AgentLabelProblem[] } {
  const settings = readAgentSettings(config);
  const project = settings.projects.find((entry) => entry.repo === repo?.toLowerCase());
  const labelProblems: AgentLabelProblem[] = [];
  const select = (role: "implementer" | "reviewer"): AgentProfile => {
    const inherited = project?.[role] ?? settings.defaults[role];
    const label = labels?.[role];
    if (label === undefined) return inherited;
    const preset = Object.entries(settings.presets ?? {}).find(
      ([name]) => name.trim().toLowerCase() === label.trim().toLowerCase(),
    )?.[1];
    if (!preset) {
      labelProblems.push({ role, label, reason: "unknown_preset" });
      return inherited;
    }
    return preset;
  };
  let implementer = select("implementer");
  let reviewer = select("reviewer");
  if (
    labels?.reviewer !== undefined &&
    reviewer.agent === implementer.agent &&
    reviewer.model === implementer.model &&
    !labelProblems.some((problem) => problem.role === "reviewer")
  ) {
    labelProblems.push({ role: "reviewer", label: labels.reviewer, reason: "same_as_implementer" });
    reviewer = project?.reviewer ?? settings.defaults.reviewer;
  }
  // A label can also collide with an inherited reviewer, including after a rejected
  // reviewer label has fallen back to the repository profile.
  if (
    labels?.implementer !== undefined &&
    reviewer.agent === implementer.agent &&
    reviewer.model === implementer.model &&
    !labelProblems.some((problem) => problem.role === "implementer")
  ) {
    labelProblems.push({
      role: "implementer",
      label: labels.implementer,
      reason: "same_as_implementer",
    });
    implementer = project?.implementer ?? settings.defaults.implementer;
  }
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
  if (!/^\s*\[agents\.(defaults|projects|presets)(?:[.\]])/m.test(text)) return null;
  const parsed = Bun.TOML.parse(text) as {
    agents?: {
      defaults?: {
        implementer?: Partial<AgentProfile>;
        reviewer?: Partial<AgentProfile>;
        reviewer_fallback?: Partial<AgentProfile>;
      };
      presets?: Record<string, Partial<AgentProfile>>;
      projects?: Record<
        string,
        {
          implementer?: Partial<AgentProfile>;
          reviewer?: Partial<AgentProfile>;
        }
      >;
    };
  };
  const agents = parsed.agents;
  return parseSettings(
    {
      defaults: {
        implementer: { model: null, ...(agents?.defaults?.implementer ?? { agent: implementer }) },
        reviewer: { model: null, ...(agents?.defaults?.reviewer ?? { agent: "codex" }) },
        ...(agents?.defaults?.reviewer_fallback
          ? { reviewerFallback: { model: null, ...agents.defaults.reviewer_fallback } }
          : {}),
      },
      ...(agents?.presets === undefined
        ? {}
        : {
            presets: Object.fromEntries(
              Object.entries(agents.presets).map(([name, profile]) => [
                name,
                { model: null, ...profile },
              ]),
            ),
          }),
      projects: Object.entries(agents?.projects ?? {}).map(([repo, profiles]) => ({
        repo,
        ...(profiles.implementer ? { implementer: { model: null, ...profiles.implementer } } : {}),
        ...(profiles.reviewer ? { reviewer: { model: null, ...profiles.reviewer } } : {}),
      })),
    },
    agents?.defaults === undefined && agents?.projects === undefined,
  );
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
  for (const [name, profile] of Object.entries(settings.presets ?? {}))
    sections.push(renderProfile(`agents.presets.${JSON.stringify(name)}`, profile));
  for (const project of settings.projects) {
    const prefix = `agents.projects.${JSON.stringify(project.repo)}`;
    if (!project.implementer && !project.reviewer) sections.push(`[${prefix}]`);
    if (project.implementer)
      sections.push(renderProfile(`${prefix}.implementer`, project.implementer));
    if (project.reviewer) sections.push(renderProfile(`${prefix}.reviewer`, project.reviewer));
  }
  const next = `${base}\n\n${sections.join("\n\n")}\n`;
  Bun.TOML.parse(next);
  return next;
}

export function selectDefaultImplementer(
  settings: AgentSettings,
  implementer: ImplementerName,
): AgentSettings {
  return parseAgentSettings({
    ...settings,
    defaults: {
      ...settings.defaults,
      implementer: {
        ...(settings.defaults.implementer.agent === implementer
          ? settings.defaults.implementer
          : {}),
        agent: implementer,
        model:
          settings.defaults.implementer.agent === implementer
            ? settings.defaults.implementer.model
            : null,
      },
    },
  });
}

export function writeAgentSettings(
  path: string,
  input: AgentSettings,
  merge?: StoredMerge,
  queue?: QueueSettings,
): void {
  updateConfigText(path, (current) => {
    const agents = renderAgentSettingsText(current, input);
    const merged = merge === undefined ? agents : setMergeSettingsText(agents, merge);
    return queue === undefined ? merged : setQueueSettingsText(merged, queue);
  });
}

/** Render already-validated presets without materializing legacy role defaults. */
export function renderAgentPresetsText(settings: AgentSettings): string {
  return Object.entries(settings.presets ?? {})
    .map(([name, profile]) => renderProfile(`agents.presets.${JSON.stringify(name)}`, profile))
    .join("\n\n");
}

function renderProfile(section: string, profile: AgentProfile): string {
  const lines = [`[${section}]`, `agent = ${JSON.stringify(profile.agent)}`];
  if (profile.model !== null) lines.push(`model = ${JSON.stringify(profile.model)}`);
  if (profile.effort !== undefined) lines.push(`effort = ${JSON.stringify(profile.effort)}`);
  return lines.join("\n");
}
