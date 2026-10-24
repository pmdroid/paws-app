import { z } from "zod";

/** Agents that load skills from their home, and the folder under the home each one reads. */
export const RUNNER_SKILL_FOLDERS = {
  claude: ".claude/skills",
  codex: ".codex/skills",
  grok: ".grok/skills",
} as const;

export type RunnerSkillAgent = keyof typeof RUNNER_SKILL_FOLDERS;

/** Bundles over this are refused, matching the limit Paws applies when a skill is added. */
export const RUNNER_SKILL_BUNDLE_LIMIT = 50 * 1024 * 1024;

const name = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
  .refine((value) => !value.includes(".."));
const version = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** One registered skill in the heartbeat reply. */
export const RunnerSkillSchema = z.strictObject({
  name,
  version,
  sha256,
  sizeBytes: z.number().int().positive().max(RUNNER_SKILL_BUNDLE_LIMIT),
  agents: z
    .array(z.enum(["claude", "codex", "grok"]))
    .min(1)
    .max(3),
});

export const RunnerSkillManifestSchema = z
  .array(RunnerSkillSchema)
  .max(256)
  .refine((skills) => new Set(skills.map((skill) => skill.name)).size === skills.length);

/**
 * A skill as the runner reports it. `installed`: every idle home has it. `pending`: a home
 * with a run in progress still holds the version that run started with. `refused`: the bundle
 * failed its checksum or download, and the previous version (if any) stays installed.
 */
export const RunnerInstalledSkillSchema = z.strictObject({
  name,
  version,
  sha256,
  status: z.enum(["installed", "pending", "refused"]),
  error: z.string().min(1).max(500).optional(),
  waiting: z.number().int().min(1).max(256).optional(),
});

export const RunnerInstalledSkillsSchema = z.array(RunnerInstalledSkillSchema).max(256);

export type RunnerSkill = z.infer<typeof RunnerSkillSchema>;
export type RunnerInstalledSkill = z.infer<typeof RunnerInstalledSkillSchema>;

/** A relative bundle path that stays inside the skill folder, or null. */
export function runnerSkillPath(path: string): string | null {
  const parts = path.replaceAll("\\", "/").split("/");
  if (parts[0] === "" && parts.length > 1) return null;
  const kept = parts.filter((part) => part !== "" && part !== ".");
  if (kept.length === 0 || kept.some((part) => part === ".." || part.includes("\0"))) return null;
  return kept.join("/");
}
