import type { PawsConfigFile } from "./file";

export type ProjectMemorySettings = {
  workSummary: boolean;
  dream: boolean;
  decisions: boolean;
};

export function readProjectMemorySettings(config: PawsConfigFile): ProjectMemorySettings {
  return {
    workSummary: config.projectMemory?.workSummary ?? false,
    dream: config.projectMemory?.dream ?? false,
    decisions: config.projectMemory?.decisions ?? false,
  };
}

export function parseProjectMemorySettings(value: unknown): Partial<ProjectMemorySettings> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("projectMemory must be an object");
  const parsed: Partial<ProjectMemorySettings> = {};
  for (const [key, flag] of Object.entries(value)) {
    if (key !== "workSummary" && key !== "dream" && key !== "decisions")
      throw new Error("projectMemory has an unknown key");
    if (typeof flag !== "boolean") throw new Error(`projectMemory.${key} must be true or false`);
    parsed[key] = flag;
  }
  return parsed;
}

export function setProjectMemorySettingsText(
  current: string,
  settings: ProjectMemorySettings,
): string {
  let section = "";
  const retained = current
    .split(/\r?\n/)
    .filter((line) => {
      const heading = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
      if (heading?.[1]) section = heading[1].trim().toLowerCase();
      return section !== "project_memory";
    })
    .join("\n")
    .trimEnd();
  const table = `[project_memory]\nwork_summary = ${settings.workSummary}\ndream = ${settings.dream}\ndecisions = ${settings.decisions}\n`;
  return retained === "" ? table : `${retained}\n\n${table}`;
}
