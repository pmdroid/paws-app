import { skillDescription, skillManifestName, skillPath, type SkillFiles } from "./bundle";

export type SkillFolder = { path: string; name: string; description: string };

const LOCATIONS = ["skills", ".claude/skills", ".agents/skills", ".codex/skills"];
const DEPTH = 3;

export function skillFolders(files: SkillFiles, fallback: string): SkillFolder[] {
  const folders = [...files.keys()]
    .filter((path) => path === "SKILL.md" || path.endsWith("/SKILL.md"))
    .map((path) => path.slice(0, -"/SKILL.md".length));
  const listed = folders.includes("")
    ? [""]
    : [...LOCATIONS, ...declaredPaths(files)].flatMap((base) =>
        folders.filter((folder) => within(folder, base)).sort(),
      );
  const seen = new Set<string>();
  return listed
    .filter((folder) => !listed.some((other) => folder.startsWith(`${other}/`)))
    .map((path) => {
      const manifest: SkillFiles = new Map([
        ["SKILL.md", files.get(path ? `${path}/SKILL.md` : "SKILL.md")!],
      ]);
      return {
        path,
        name: skillManifestName(manifest) ?? (path.split("/").at(-1) || fallback),
        description: skillDescription(manifest),
      };
    })
    .filter((skill) => !seen.has(skill.name) && seen.add(skill.name));
}

function within(folder: string, base: string): boolean {
  if (folder === base) return true;
  return (
    folder.startsWith(`${base}/`) && folder.split("/").length - base.split("/").length <= DEPTH
  );
}

function declaredPaths(files: SkillFiles): string[] {
  const plugin = manifestJson(files, ".claude-plugin/plugin.json");
  const marketplace = manifestJson(files, ".claude-plugin/marketplace.json");
  const plugins = Array.isArray(marketplace.plugins) ? (marketplace.plugins as unknown[]) : [];
  return [
    ...strings(plugin.skills),
    ...plugins.flatMap((entry) => {
      const { source, skills } = (entry ?? {}) as { source?: unknown; skills?: unknown };
      return typeof source === "string" ? strings(skills).map((path) => `${source}/${path}`) : [];
    }),
  ]
    .map(skillPath)
    .filter((path) => path !== null);
}

function manifestJson(files: SkillFiles, path: string): { skills?: unknown; plugins?: unknown } {
  const bytes = files.get(path);
  if (bytes === undefined) return {};
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value !== null && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}
