import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { projectSkillsRoot, type PawsConfigFile } from "../config";
import { git } from "./git";
import { isInside } from "./permissions";

export async function loadImplementationSkills(input: {
  config: PawsConfigFile;
  root?: string;
  pawsRoot: string;
  worktree: string;
  repository?: string;
  signal?: AbortSignal;
}): Promise<{ prompt: string; roots: string[] }> {
  if (!input.root && !input.config.projectSkills?.length) return { prompt: "", roots: [] };
  let repository = input.repository;
  if (!repository) {
    const origin = await git(["-C", input.worktree, "config", "--get", "remote.origin.url"], {
      signal: input.signal,
    }).catch(() => "");
    repository = /(?:github\.com[:/])([^/]+\/[^/]+?)(?:\.git)?$/.exec(origin.trim())?.[1];
  }
  const configured =
    input.root ?? (repository && projectSkillsRoot(input.config, input.pawsRoot, repository));
  if (!configured) return { prompt: "", roots: [] };
  const root = realpathSync(configured);
  const worktree = realpathSync(input.worktree);
  if (isInside(worktree, root) || isInside(root, worktree))
    throw new Error("Local skills must be outside the repository worktree");
  const roots: string[] = [];
  const sections: string[] = [];
  let bytes = 0;
  for (const name of readdirSync(root).sort()) {
    const directory = join(root, name);
    if (!lstatSync(directory).isDirectory()) continue;
    const skillPath = join(directory, "SKILL.md");
    let skillInfo;
    try {
      skillInfo = lstatSync(skillPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) || !skillInfo.isFile())
      throw new Error("Local skills require named directories with regular SKILL.md files");
    bytes += skillInfo.size;
    if (bytes > 1024 * 1024 || roots.length >= 100)
      throw new Error("Local skills exceed the limit of 100 skills or 1 MiB of instructions");
    roots.push(directory);
    sections.push(`Local skill ${name}\nSource: ${skillPath}\n${readFileSync(skillPath, "utf8")}`);
  }
  if (!roots.length) throw new Error(`No local skills found in ${configured}`);
  return {
    roots,
    prompt: [
      "Paws local implementation skills",
      "Use these local skill instructions when applicable. Each named local skill replaces the repository skill with the same directory name, including .agents/skills and .claude/skills. Other repository skills remain available.",
      "Resolve each skill's resources relative to its Source directory. Read resources with file tools or cat using absolute paths. Run scripts with a direct command and arguments, for example bash /absolute/skill/scripts/check.sh. Keep local skills and their resources outside repository files and commits.",
      ...sections,
    ].join("\n\n"),
  };
}
