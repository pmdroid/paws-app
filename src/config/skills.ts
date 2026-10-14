import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { PawsConfigFile } from "./file";

export type ProjectSkills = { repo: string; root: string };

const skillsSchema = z.strictObject({
  projects: z.record(
    z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/),
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
