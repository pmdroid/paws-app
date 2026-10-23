import type { SkillFiles } from "./bundle";

export type SkillFolder = { path: string; name: string; description: string };

export function skillFolders(_files: SkillFiles, _fallback: string): SkillFolder[] {
  return [];
}
