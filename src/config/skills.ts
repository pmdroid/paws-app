import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { PawsConfigFile } from "./file";
import { updateConfigText } from "./settings-store";

export type ProjectSkills = { repo: string; root: string };

const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;

const skillsSchema = z.strictObject({
  projects: z.record(
    z.string().regex(REPOSITORY),
    z.strictObject({
      root: z
        .string()
        .trim()
        .min(1)
        .refine((value) => [...value].every((char) => char.charCodeAt(0) > 31)),
    }),
  ),
});

export function parseProjectSkills(text: string): ProjectSkills[] {
  if (!/^\s*\[skills(?:\.|\])/m.test(text)) return [];
  const parsed = Bun.TOML.parse(text) as { skills?: unknown };
  const skills = skillsSchema.parse(parsed.skills);
  const projects = Object.entries(skills.projects).map(([repo, value]) => ({
    repo: repo.toLowerCase(),
    root: value.root,
  }));
  if (new Set(projects.map((project) => project.repo)).size !== projects.length)
    throw new Error("Duplicate skills project");
  return projects;
}

export function projectSkillsRoot(
  config: PawsConfigFile,
  pawsRoot: string,
  repository: string,
): string | undefined {
  const root = config.projectSkills?.find((entry) => entry.repo === repository.toLowerCase())?.root;
  return root === undefined ? undefined : isAbsolute(root) ? root : resolve(pawsRoot, root);
}

export function renderProjectSkills(projects: readonly ProjectSkills[]): string {
  return projects
    .map(
      ({ repo, root }) =>
        `\n[skills.projects.${JSON.stringify(repo)}]\nroot = ${JSON.stringify(root)}\n`,
    )
    .join("");
}

export type ProjectSkillRoots = { projects: Record<string, { root: string }> };

export function readProjectSkillRoots(config: PawsConfigFile): ProjectSkillRoots {
  return {
    projects: Object.fromEntries(
      (config.projectSkills ?? []).map(({ repo, root }) => [repo, { root }]),
    ),
  };
}

export function parseProjectSkillRoots(value: unknown): ProjectSkills[] {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error('Expected { projects: { "owner/repo": { root } } }');
  const { projects, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0) throw new Error("Expected only projects");
  if (typeof projects !== "object" || projects === null || Array.isArray(projects))
    throw new Error("Expected projects to be an object of repositories");
  const parsed = Object.entries(projects).map(([repo, entry]) => {
    if (!REPOSITORY.test(repo)) throw new Error(`${repo} is not an owner/repo name`);
    const root =
      typeof entry === "object" && entry !== null && !Array.isArray(entry)
        ? (entry as Record<string, unknown>).root
        : undefined;
    if (typeof root !== "string" || root.trim() === "")
      throw new Error(`${repo} needs a root directory`);
    const path = root.trim();
    if ([...path].some((char) => char.charCodeAt(0) <= 31))
      throw new Error(`${repo} root has a control character`);
    if (!isAbsolute(path)) throw new Error(`${repo} root must be an absolute path`);
    if (!statSync(path, { throwIfNoEntry: false })?.isDirectory())
      throw new Error(`${repo} root ${path} is not a directory on the Paws host`);
    return { repo: repo.toLowerCase(), root: path };
  });
  if (new Set(parsed.map((project) => project.repo)).size !== parsed.length)
    throw new Error("Duplicate skills project");
  return parsed;
}

export function writeProjectSkills(
  path: string,
  projects: readonly ProjectSkills[],
): Promise<void> {
  return updateConfigText(path, (text) => {
    let section = "";
    const retained = text
      .split(/\r?\n/)
      .filter((line) => {
        const heading = /^\s*\[\[?\s*([^[\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
        if (heading?.[1]) section = heading[1].toLowerCase();
        return section !== "skills" && !section.startsWith("skills.");
      })
      .join("\n")
      .trimEnd();
    return `${retained}\n${renderProjectSkills(projects)}`.trimStart();
  });
}
