import type { PawsConfigFile } from "./file";

export const DEFAULT_CI_FIX_ATTEMPTS = 3;
export const MAX_CI_FIX_ATTEMPTS = 10;

/** Workspace merge settings. PAS-388 adds project and label rules on top. */
export type MergeSettings = { closeoutAfterUpdate: boolean; ciFixAttempts: number };

export function readMergeSettings(config: PawsConfigFile): MergeSettings {
  return {
    closeoutAfterUpdate: config.closeoutAfterUpdate === true,
    ciFixAttempts: Math.min(config.ciFixAttempts ?? DEFAULT_CI_FIX_ATTEMPTS, MAX_CI_FIX_ATTEMPTS),
  };
}

/** A missing key keeps the stored value, so an older form cannot reset the other setting. */
export function parseMergeSettings(value: unknown): Partial<MergeSettings> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("merge must be an object");
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "closeoutAfterUpdate" && key !== "ciFixAttempts"))
    throw new Error("merge has an unknown key");
  const { closeoutAfterUpdate, ciFixAttempts } = value as Record<string, unknown>;
  if (closeoutAfterUpdate !== undefined && typeof closeoutAfterUpdate !== "boolean")
    throw new Error("merge.closeoutAfterUpdate must be true or false");
  if (
    ciFixAttempts !== undefined &&
    (typeof ciFixAttempts !== "number" ||
      !Number.isInteger(ciFixAttempts) ||
      ciFixAttempts < 0 ||
      ciFixAttempts > MAX_CI_FIX_ATTEMPTS)
  )
    throw new Error(`merge.ciFixAttempts must be a whole number from 0 to ${MAX_CI_FIX_ATTEMPTS}`);
  return {
    ...(closeoutAfterUpdate === undefined ? {} : { closeoutAfterUpdate }),
    ...(ciFixAttempts === undefined ? {} : { ciFixAttempts }),
  };
}

export function renderMergeSettings(settings: Partial<MergeSettings>): string {
  const lines = [
    ...(settings.closeoutAfterUpdate === undefined
      ? []
      : [`closeout_after_update = ${settings.closeoutAfterUpdate}`]),
    ...(settings.ciFixAttempts === undefined
      ? []
      : [`ci_fix_attempts = ${settings.ciFixAttempts}`]),
  ];
  return lines.length === 0 ? "" : `\n[merge]\n${lines.join("\n")}\n`;
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
  const table = renderMergeSettings(settings);
  return retained === "" ? table.trimStart() : `${retained}\n${table}`;
}
