import { saveSettingsSection } from "./file";

export type SplitSettings = {
  enabled: boolean;
  maxSubIssues: number;
  approvalsBeforeAuto: number;
};

export const SPLIT_SETTINGS_DEFAULTS: SplitSettings = {
  enabled: true,
  maxSubIssues: 2,
  approvalsBeforeAuto: 2,
};

const RANGES = {
  maxSubIssues: { key: "max_sub_issues", min: 1, max: 5 },
  approvalsBeforeAuto: { key: "approvals_before_auto", min: 0, max: 10 },
} as const;

function whole(name: string, value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`splits.${name} must be a whole number from ${min} to ${max}`);
  return value;
}

export function splitSettings(section: unknown): SplitSettings {
  const table =
    typeof section === "object" && section !== null && !Array.isArray(section)
      ? (section as Record<string, unknown>)
      : {};
  const settings = { ...SPLIT_SETTINGS_DEFAULTS };
  if (typeof table["enabled"] === "boolean") settings.enabled = table["enabled"];
  for (const field of ["maxSubIssues", "approvalsBeforeAuto"] as const) {
    const { key, min, max } = RANGES[field];
    const value = table[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max)
      settings[field] = value;
  }
  return settings;
}

export function parseSplitSettings(value: unknown): SplitSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("splits must be an object");
  const body = value as Record<string, unknown>;
  const unknown = Object.keys(body).find(
    (name) => !["enabled", "maxSubIssues", "approvalsBeforeAuto"].includes(name),
  );
  if (unknown !== undefined)
    throw new Error(
      `splits has an unknown field: ${unknown} (use enabled, maxSubIssues, approvalsBeforeAuto)`,
    );
  if (typeof body["enabled"] !== "boolean") throw new Error("splits.enabled must be true or false");
  return {
    enabled: body["enabled"],
    maxSubIssues: whole("maxSubIssues", body["maxSubIssues"], 1, 5),
    approvalsBeforeAuto: whole("approvalsBeforeAuto", body["approvalsBeforeAuto"], 0, 10),
  };
}

export function writeSplitSettings(home: string, settings: SplitSettings): Promise<void> {
  return saveSettingsSection(home, "splits", {
    enabled: settings.enabled,
    max_sub_issues: settings.maxSubIssues,
    approvals_before_auto: settings.approvalsBeforeAuto,
  });
}
