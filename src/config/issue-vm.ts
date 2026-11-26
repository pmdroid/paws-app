import { saveSettingsSection } from "./file";

export type IssueVmSettings = {
  perMember: number;
  workspaceMax: number;
  deleteAfterDays: number;
};

export type StoredIssueVmSettings = Partial<IssueVmSettings>;

const ISSUE_VM_KEYS = {
  per_member: { field: "perMember", min: 0, max: 50, fallback: 2 },
  workspace_max: { field: "workspaceMax", min: 1, max: 500, fallback: 10 },
  delete_after_days: { field: "deleteAfterDays", min: 1, max: 60, fallback: 7 },
} as const;

type IssueVmKey = keyof typeof ISSUE_VM_KEYS;

const KEYS = Object.keys(ISSUE_VM_KEYS) as IssueVmKey[];

function isIssueVmKey(key: string): key is IssueVmKey {
  return Object.hasOwn(ISSUE_VM_KEYS, key);
}

function checkIssueVmValue(key: IssueVmKey, value: unknown): number {
  const { min, max } = ISSUE_VM_KEYS[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`issue_vm.${key} must be a whole number from ${min} to ${max}`);
  return value;
}

export function assignIssueVmKey(
  settings: StoredIssueVmSettings,
  key: string,
  value: string | number | boolean | string[],
): void {
  if (!isIssueVmKey(key))
    throw new Error(`Saved settings have an unknown key: issue_vm.${key} (use ${KEYS.join(", ")})`);
  try {
    settings[ISSUE_VM_KEYS[key].field] = checkIssueVmValue(key, value);
  } catch (error) {
    throw new Error(`Saved settings ${(error as Error).message}`, { cause: error });
  }
}

export function issueVmSettings(stored: StoredIssueVmSettings | undefined): IssueVmSettings {
  const resolved = {} as IssueVmSettings;
  for (const key of KEYS) {
    const { field, fallback } = ISSUE_VM_KEYS[key];
    resolved[field] = stored?.[field] ?? fallback;
  }
  return resolved;
}

export function parseIssueVmSettings(value: unknown): StoredIssueVmSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("issue_vm must be an object");
  const fields: string[] = KEYS.map((key) => ISSUE_VM_KEYS[key].field);
  const unknown = Object.keys(value).find((name) => !fields.includes(name));
  if (unknown !== undefined)
    throw new Error(`issue_vm has an unknown field: ${unknown} (use ${fields.join(", ")})`);
  const settings: StoredIssueVmSettings = {};
  for (const key of KEYS) {
    const { field } = ISSUE_VM_KEYS[key];
    const raw = (value as Record<string, unknown>)[field];
    if (raw !== undefined && raw !== null) settings[field] = checkIssueVmValue(key, raw);
  }
  return settings;
}

export function writeIssueVmSettings(path: string, settings: StoredIssueVmSettings): Promise<void> {
  const section = Object.fromEntries(
    KEYS.flatMap((key) => {
      const value = settings[ISSUE_VM_KEYS[key].field];
      return value === undefined ? [] : [[key, value]];
    }),
  );
  return saveSettingsSection(path, "issue_vm", Object.keys(section).length ? section : undefined);
}
