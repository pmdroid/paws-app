import {
  readSettingSections,
  SETTINGS_SECTIONS,
  settingsSectionsOf,
  type SettingSections,
} from "../src/config";
import {
  readSettingSectionsSteps,
  settingSectionsStore,
  updateSettingSectionsSteps,
  type Db,
} from "../src/db";

export function sectionSettings(db: Db) {
  return settingSectionsStore(db, SETTINGS_SECTIONS);
}

export async function seedSettings(db: Db, text: string): Promise<void> {
  await db.transaction((q) =>
    updateSettingSectionsSteps(q, SETTINGS_SECTIONS, () => settingsSectionsOf(text)),
  );
}

export async function savedSettingsText(db: Db): Promise<string> {
  return renderSettingsToml(await db.run((q) => readSettingSectionsSteps(q, SETTINGS_SECTIONS)));
}

export function readConfigText(configPath: string): string {
  return renderSettingsToml(readSettingSections(configPath));
}

export function renderSettingsToml(sections: SettingSections): string {
  const out: string[] = [];
  for (const name of SETTINGS_SECTIONS)
    if (sections[name] !== undefined) renderTable(out, [name], sections[name], false);
  return out.length === 0 ? "" : `${out.join("\n").trim()}\n`;
}

function renderTable(out: string[], path: string[], value: unknown, item: boolean): void {
  const entries = Object.entries(value as Record<string, unknown>);
  const isTable = (entry: unknown) =>
    typeof entry === "object" && entry !== null && !Array.isArray(entry);
  const isTables = (entry: unknown) =>
    Array.isArray(entry) && entry.length > 0 && entry.every(isTable);
  const plain = entries.filter(([, entry]) => !isTable(entry) && !isTables(entry));
  const header = path.map(tomlKey).join(".");
  if (item) out.push("", `[[${header}]]`);
  else if (plain.length > 0 || entries.length === 0) out.push("", `[${header}]`);
  for (const [key, entry] of plain) out.push(`${tomlKey(key)} = ${tomlValue(entry)}`);
  for (const [key, entry] of entries) {
    if (isTable(entry)) renderTable(out, [...path, key], entry, false);
    else if (isTables(entry))
      for (const element of entry as unknown[]) renderTable(out, [...path, key], element, true);
  }
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlValue(key);
}

function tomlValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (typeof value === "string") return JSON.stringify(value).replaceAll("\x7f", "\\u007f");
  if (typeof value === "object" && value !== null)
    return `{ ${Object.entries(value)
      .map(([key, entry]) => `${tomlKey(key)} = ${tomlValue(entry)}`)
      .join(", ")} }`;
  return String(value);
}
