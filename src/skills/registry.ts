import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import {
  getSkill,
  markSkillRemoved,
  saveSkill,
  setSkillAgents,
  SKILL_AGENTS,
  type SkillAgent,
  type SkillPin,
  type SkillSource,
} from "../db";
import {
  skillContentHash,
  skillManifestName,
  SkillError,
  skillPath,
  skillSubfolder,
  validSkillName,
  writeSkillBundle,
  type SkillFiles,
} from "./bundle";
import { skillFolders, skillManifests, type SkillFolder } from "./discover";
import type { SkillHook } from "./hooks";
import type { SkillRequest, SkillResolver } from "./resolve";

export type SkillRegistry = {
  db: Database;
  /** `~/.paws/skills`. */
  root: string;
  resolver: SkillResolver;
  now: number;
  limit?: number;
  signal?: AbortSignal;
};

/** The chosen agents in a stable order, or every agent that supports skills. */
export function skillAgents(agents: readonly string[] | undefined): SkillAgent[] {
  if (agents === undefined) return [...SKILL_AGENTS];
  const unknown = agents.filter((agent) => !(SKILL_AGENTS as readonly string[]).includes(agent));
  if (unknown.length) throw new SkillError(`Skills do not apply to ${unknown.join(", ")}.`);
  const chosen = SKILL_AGENTS.filter((agent) => agents.includes(agent));
  if (chosen.length === 0) throw new SkillError("Choose at least one agent for this skill.");
  return chosen;
}

/** Resolve an npm package or git URL, bundle it, and pin it under a new name. */
export async function addSkill(
  registry: SkillRegistry,
  request: SkillRequest,
  options: { name?: string; agents?: readonly string[] } = {},
): Promise<SkillPin> {
  const agents = skillAgents(options.agents);
  const resolved = await registry.resolver.resolve(request, registry.signal);
  const name = chooseName(options.name, resolved.files, resolved.suggestedName);
  return pin(
    registry,
    { name, source: resolved.source, version: resolved.version, agents },
    resolved.files,
  );
}

export type FoundSkill = SkillFolder & { added: boolean; hooks: SkillHook[] };

export async function findSkills(
  registry: SkillRegistry,
  request: SkillRequest,
): Promise<FoundSkill[]> {
  const resolved = await registry.resolver.resolve(request, registry.signal, skillManifests);
  return skillFolders(resolved.files, resolved.suggestedName).map((skill) => {
    const name = skillName(skill.name);
    const existing = getSkill(registry.db, name);
    return { ...skill, name, added: existing !== null && existing.removedAt === null, hooks: [] };
  });
}

export async function addSkills(
  registry: SkillRegistry,
  request: SkillRequest,
  paths: readonly string[],
  options: { agents?: readonly string[] } = {},
): Promise<SkillPin[]> {
  const agents = skillAgents(options.agents);
  if (paths.length === 0) throw new SkillError("Choose at least one skill to add.");
  if (paths.some((path) => path !== "" && skillPath(path) !== path))
    throw new SkillError("The subfolder must be a relative path.");
  const resolved = await registry.resolver.resolve(request, registry.signal, () => paths);
  const pins: SkillPin[] = [];
  for (const path of paths) {
    const subfolder = [resolved.source.subfolder, path].filter(Boolean).join("/");
    const files = skillSubfolder(resolved.files, path || undefined);
    const name = chooseName(undefined, files, path.split("/").at(-1) || resolved.suggestedName);
    pins.push(
      await pin(
        registry,
        {
          name,
          source: subfolder ? { ...resolved.source, subfolder } : resolved.source,
          version: resolved.version,
          agents,
        },
        files,
      ),
    );
  }
  return pins;
}

/** Pin an uploaded folder. Its version is the checksum of its contents. */
export async function addUploadedSkill(
  registry: SkillRegistry,
  folder: string,
  files: SkillFiles,
  options: { name?: string; agents?: readonly string[] } = {},
): Promise<SkillPin> {
  const agents = skillAgents(options.agents);
  const name = chooseName(options.name, files, folder);
  const version = skillContentHash(files).slice(0, 12);
  return pin(registry, { name, source: { kind: "upload", folder }, version, agents }, files);
}

/** Resolve the newest version of the skill's source and replace the pin. */
export async function updateSkill(
  registry: SkillRegistry,
  name: string,
): Promise<{ before: SkillPin; after: SkillPin }> {
  const before = activeSkill(registry.db, name);
  if (before.source.kind === "upload")
    throw new SkillError("An uploaded skill has no source to update. Upload the folder again.");
  const resolved = await registry.resolver.resolve(before.source, registry.signal);
  if (resolved.version === before.version) return { before, after: before };
  const after = await pin(
    registry,
    { name, source: before.source, version: resolved.version, agents: before.agents },
    resolved.files,
    true,
  );
  rmSync(join(registry.root, name, before.version), { recursive: true, force: true });
  return { before, after };
}

export function changeSkillAgents(
  registry: Pick<SkillRegistry, "db" | "now">,
  name: string,
  agents: readonly string[],
): { before: SkillPin; after: SkillPin } {
  const before = activeSkill(registry.db, name);
  setSkillAgents(registry.db, name, skillAgents(agents), registry.now);
  return { before, after: getSkill(registry.db, name)! };
}

/** Mark the skill for removal. Runners uninstall it; the bundle stays until it is re-added. */
export function removeSkill(registry: Pick<SkillRegistry, "db" | "now">, name: string): SkillPin {
  activeSkill(registry.db, name);
  markSkillRemoved(registry.db, name, registry.now);
  return getSkill(registry.db, name)!;
}

function activeSkill(db: Database, name: string): SkillPin {
  const skill = getSkill(db, name);
  if (skill === null || skill.removedAt !== null)
    throw new SkillError(`No skill named ${name} is registered.`, 404);
  return skill;
}

function skillName(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 64);
}

function chooseName(requested: string | undefined, files: SkillFiles, fallback: string): string {
  const name = skillName(requested?.trim() || skillManifestName(files) || fallback);
  if (!validSkillName(name)) throw new SkillError("Name the skill with letters, digits, - or _.");
  return name;
}

async function pin(
  registry: SkillRegistry,
  skill: { name: string; source: SkillSource; version: string; agents: SkillAgent[] },
  files: SkillFiles,
  replacing = false,
): Promise<SkillPin> {
  const existing = getSkill(registry.db, skill.name);
  if (!replacing && existing !== null && existing.removedAt === null)
    throw new SkillError(
      `A skill named ${skill.name} is already registered. Update it instead.`,
      409,
    );
  const bundle = await writeSkillBundle(files, {
    root: registry.root,
    name: skill.name,
    version: skill.version,
    ...(registry.limit === undefined ? {} : { limit: registry.limit }),
  });
  saveSkill(registry.db, {
    ...skill,
    sha256: bundle.sha256,
    sizeBytes: bundle.sizeBytes,
    updatedAt: registry.now,
  });
  return getSkill(registry.db, skill.name)!;
}
