import type { HookEvent } from "../core";
import type { SkillFiles } from "./bundle";

export type SkillHook = {
  id: string;
  source: string;
  event: HookEvent | null;
  label: string;
  matcher: string | null;
  command: string;
  timeoutSeconds: number;
  reason: string | null;
};

export function skillHooks(_files: SkillFiles, _folder: string): SkillHook[] {
  return [];
}
