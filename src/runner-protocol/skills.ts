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

function* tarFiles(tar: Uint8Array): Generator<{ path: string; header: number; mode: number }> {
  const field = (from: number, length: number) =>
    new TextDecoder().decode(tar.subarray(from, from + length)).replace(/\0[\s\S]*$/, "");
  let paxPath: string | undefined;
  for (let at = 0; at + 512 <= tar.length && tar[at] !== 0;) {
    const size = parseInt(field(at + 124, 12).trim() || "0", 8);
    const type = field(at + 156, 1);
    if (type === "x") paxPath = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(field(at + 512, size))?.[1];
    else {
      const base = field(at, 100);
      const prefix = field(at + 257, 6) === "ustar" ? field(at + 345, 155) : "";
      if (type === "0" || type === "")
        yield {
          path: paxPath ?? (prefix ? `${prefix}/${base}` : base),
          header: at,
          mode: parseInt(field(at + 100, 8).trim() || "0", 8),
        };
      paxPath = undefined;
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
}

export function tarModes(archive: Uint8Array<ArrayBuffer>): Map<string, number> {
  const tar = archive[0] === 0x1f && archive[1] === 0x8b ? Bun.gunzipSync(archive) : archive;
  return new Map([...tarFiles(tar)].map(({ path, mode }) => [path, mode]));
}

export function withTarModes<T extends Uint8Array>(tar: T, modes: ReadonlyMap<string, number>): T {
  const encode = (text: string) => new TextEncoder().encode(text);
  for (const { path, header } of tarFiles(tar)) {
    const mode = modes.get(path);
    if (mode === undefined) continue;
    tar.set(encode(`${mode.toString(8).padStart(7, "0")}\0`), header + 100);
    tar.fill(0x20, header + 148, header + 156);
    const sum = tar.subarray(header, header + 512).reduce((total, byte) => total + byte, 0);
    tar.set(encode(`${sum.toString(8).padStart(6, "0")}\0 `), header + 148);
  }
  return tar;
}
