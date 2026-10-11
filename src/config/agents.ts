import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { setImplementerText, type ImplementerName, type PawsConfigFile } from "./file";

export type AgentProfile = { agent: ImplementerName; model: string | null };
export type AgentProfiles = { implementer: AgentProfile; reviewer: AgentProfile };
export type ProjectAgentProfiles = {
  repo: string;
  implementer?: AgentProfile;
  reviewer?: AgentProfile;
};
export type AgentSettings = { defaults: AgentProfiles; projects: ProjectAgentProfiles[] };

const profileSchema = z.strictObject({
  agent: z.enum(["claude", "grok", "codex"]),
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
});
const projectSchema = z.strictObject({
  repo: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\/[a-zA-Z0-9_.-]+$/)
    .max(240)
    .transform((value) => value.toLowerCase()),
  implementer: profileSchema.optional(),
  reviewer: profileSchema.optional(),
});
const settingsSchema = z.strictObject({
  defaults: z.strictObject({ implementer: profileSchema, reviewer: profileSchema }),
  projects: z.array(projectSchema).max(200),
});

export function parseAgentProfile(value: unknown): AgentProfile {
  return profileSchema.parse(value);
}

export function parseAgentSettings(value: unknown): AgentSettings {
  const settings = settingsSchema.parse(value);
  const repos = new Set<string>();
  validateIndependence(settings.defaults);
  for (const project of settings.projects) {
    if (repos.has(project.repo)) throw new Error(`Duplicate project: ${project.repo}`);
    repos.add(project.repo);
    validateIndependence({ ...settings.defaults, ...project });
  }
  return settings;
}

function validateIndependence(profiles: AgentProfiles): void {
  if (
    profiles.implementer.agent === profiles.reviewer.agent &&
    profiles.implementer.model === profiles.reviewer.model
  ) {
    throw new Error("Implementer and reviewer must use different agents or different models");
  }
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

export function resolveAgentProfiles(config: PawsConfigFile, repo?: string): AgentProfiles {
  const settings = readAgentSettings(config);
  const project = settings.projects.find((entry) => entry.repo === repo?.toLowerCase());
  return {
    implementer: project?.implementer ?? settings.defaults.implementer,
    reviewer: project?.reviewer ?? settings.defaults.reviewer,
  };
}

export function parseAgentSettingsToml(
  text: string,
  implementer: ImplementerName,
): AgentSettings | null {
  if (!/^\s*\[agents\.(defaults|projects)(?:[.\]])/m.test(text)) return null;
  const parsed = Bun.TOML.parse(text) as {
    agents?: {
      defaults?: { implementer?: Partial<AgentProfile>; reviewer?: Partial<AgentProfile> };
      projects?: Record<
        string,
        { implementer?: Partial<AgentProfile>; reviewer?: Partial<AgentProfile> }
      >;
    };
  };
  const agents = parsed.agents;
  return parseAgentSettings({
    defaults: {
      implementer: { model: null, ...(agents?.defaults?.implementer ?? { agent: implementer }) },
      reviewer: { model: null, ...(agents?.defaults?.reviewer ?? { agent: "codex" }) },
    },
    projects: Object.entries(agents?.projects ?? {}).map(([repo, profiles]) => ({
      repo,
      ...(profiles.implementer ? { implementer: { model: null, ...profiles.implementer } } : {}),
      ...(profiles.reviewer ? { reviewer: { model: null, ...profiles.reviewer } } : {}),
    })),
  });
}

export function renderAgentSettingsText(current: string, input: AgentSettings): string {
  const settings = parseAgentSettings(input);
  let section = "";
  const retained = current
    .split(/\r?\n/)
    .filter((line) => {
      const heading = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
      if (heading?.[1]) section = heading[1].trim();
      return !/^agents\.(defaults|projects)(?:\.|$)/i.test(section);
    })
    .join("\n");
  const base = setImplementerText(retained, settings.defaults.implementer.agent).trimEnd();
  const sections = [
    renderProfile("agents.defaults.implementer", settings.defaults.implementer),
    renderProfile("agents.defaults.reviewer", settings.defaults.reviewer),
  ];
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
        agent: implementer,
        model:
          settings.defaults.implementer.agent === implementer
            ? settings.defaults.implementer.model
            : null,
      },
    },
  });
}

export function writeAgentSettings(path: string, input: AgentSettings): void {
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const next = renderAgentSettingsText(current, input);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const mode = existsSync(path) ? statSync(path).mode & 0o600 : 0o600;
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(temp, next, { mode });
    chmodSync(temp, mode);
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

function renderProfile(section: string, profile: AgentProfile): string {
  const lines = [`[${section}]`, `agent = ${JSON.stringify(profile.agent)}`];
  if (profile.model !== null) lines.push(`model = ${JSON.stringify(profile.model)}`);
  return lines.join("\n");
}
