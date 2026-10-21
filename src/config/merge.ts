import type { PawsConfigFile } from "./file";

/** Workspace merge settings. PAS-388 adds project and label rules on top. */
export type MergeSettings = { closeoutAfterUpdate: boolean };

export function readMergeSettings(config: PawsConfigFile): MergeSettings {
  return { closeoutAfterUpdate: config.closeoutAfterUpdate === true };
}

export function parseMergeSettings(value: unknown): MergeSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("merge must be an object");
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "closeoutAfterUpdate"))
    throw new Error("merge has an unknown key");
  const closeoutAfterUpdate = (value as { closeoutAfterUpdate?: unknown }).closeoutAfterUpdate;
  if (typeof closeoutAfterUpdate !== "boolean")
    throw new Error("merge.closeoutAfterUpdate must be true or false");
  return { closeoutAfterUpdate };
}

export function renderMergeSettings(closeoutAfterUpdate: boolean | undefined): string {
  return closeoutAfterUpdate === undefined
    ? ""
    : `\n[merge]\ncloseout_after_update = ${closeoutAfterUpdate}\n`;
}

/** Replace the `[merge]` table, keeping every other line. */
export function setMergeSettingsText(current: string, settings: MergeSettings): string {
  let section = "";
  const retained = current
    .split(/\r?\n/)
    .filter((line) => {
      const heading = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
      if (heading?.[1]) section = heading[1].trim().toLowerCase();
      return section !== "merge";
    })
    .join("\n")
    .trimEnd();
  const table = renderMergeSettings(settings.closeoutAfterUpdate);
  return retained === "" ? table.trimStart() : `${retained}\n${table}`;
}
