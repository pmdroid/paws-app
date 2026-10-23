import { SkillError } from "./bundle";
import type { SkillRequest } from "./resolve";

export function readSkillSource(_text: string): SkillRequest {
  throw new SkillError("Choose an npm package or a git URL.");
}
