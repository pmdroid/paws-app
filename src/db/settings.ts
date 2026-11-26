import { eq, inArray } from "drizzle-orm";
import { type Q, type Db } from "./db";

export const CONFIG_SETTINGS_KEY = "config.toml";

export function* readSettingSteps(q: Q, key: string) {
  const { setting } = q.t;
  const row = yield* q.one(
    q.orm.select({ value: setting.value }).from(setting).where(eq(setting.key, key)),
  );
  return row?.value ?? null;
}

export async function readSetting(store: Db, key: string): Promise<string | null> {
  return await store.run((q) => readSettingSteps(q, key));
}

export function* updateSettingSteps(
  q: Q,
  key: string,
  change: (stored: string | null) => string,
  now = Date.now(),
) {
  const { setting } = q.t;
  const value = change(yield* readSettingSteps(q, key));
  yield* q.exec(
    q.orm
      .insert(setting)
      .values({ key, value, updatedAt: now })
      .onConflictDoUpdate({ target: setting.key, set: { value, updatedAt: now } }),
  );
}

export async function updateSetting(
  store: Db,
  key: string,
  change: (stored: string | null) => string,
  now = Date.now(),
): Promise<void> {
  await store.transaction((q) => updateSettingSteps(q, key, change, now));
}

export const SETTINGS_SECTION_PREFIX = "settings.";

type Sections = Record<string, unknown>;

export function* deleteSettingSteps(q: Q, key: string) {
  const { setting } = q.t;
  yield* q.exec(q.orm.delete(setting).where(eq(setting.key, key)));
}

export function* readSettingSectionsSteps(q: Q, names: readonly string[]) {
  const { setting } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ key: setting.key, value: setting.value })
      .from(setting)
      .where(
        inArray(
          setting.key,
          names.map((name) => SETTINGS_SECTION_PREFIX + name),
        ),
      ),
  );
  const sections: Sections = {};
  for (const row of rows)
    sections[row.key.slice(SETTINGS_SECTION_PREFIX.length)] = JSON.parse(row.value);
  return sections;
}

export function* updateSettingSectionsSteps(
  q: Q,
  names: readonly string[],
  change: (stored: Sections) => Sections,
  now = Date.now(),
) {
  const stored = yield* readSettingSectionsSteps(q, names);
  const next = change(stored);
  for (const name of names) {
    if (sectionJson(stored[name]) === sectionJson(next[name])) continue;
    const key = SETTINGS_SECTION_PREFIX + name;
    if (next[name] === undefined) yield* deleteSettingSteps(q, key);
    else yield* updateSettingSteps(q, key, () => JSON.stringify(next[name]), now);
  }
}

function sectionJson(value: unknown): string | null {
  if (value === undefined) return null;
  return JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === "object" && entry !== null && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : entry,
  );
}

export function* convertConfigSettingsSteps(
  q: Q,
  names: readonly string[],
  sectionsOf: (text: string) => Sections,
  now = Date.now(),
) {
  const text = yield* readSettingSteps(q, CONFIG_SETTINGS_KEY);
  if (text === null) return false;
  const sections = sectionsOf(text);
  yield* updateSettingSectionsSteps(q, names, () => sections, now);
  yield* deleteSettingSteps(q, CONFIG_SETTINGS_KEY);
  return true;
}

export function settingSectionsStore(store: Db, names: readonly string[]) {
  return {
    read: () => store.run((q) => readSettingSectionsSteps(q, names)),
    update: (change: (stored: Sections) => Sections) =>
      store.transaction((q) => updateSettingSectionsSteps(q, names, change)),
  };
}
