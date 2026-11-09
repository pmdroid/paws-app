import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { eq } from "drizzle-orm";
import { settled, sqliteDb, type Q } from "./db";
import { isLegacyDatabase } from "./migrate";

export const CONFIG_SETTINGS_KEY = "config.toml";

export function* readSettingSteps(q: Q, key: string) {
  const { setting } = q.t;
  const row = yield* q.one(
    q.orm.select({ value: setting.value }).from(setting).where(eq(setting.key, key)),
  );
  return row?.value ?? null;
}

export function readSetting(db: Database, key: string): string | null {
  return settled(sqliteDb(db).run((q) => readSettingSteps(q, key)));
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

export function updateSetting(
  db: Database,
  key: string,
  change: (stored: string | null) => string,
  now = Date.now(),
): void {
  settled(sqliteDb(db).transaction((q) => updateSettingSteps(q, key, change, now)));
}

export function readSavedSettings(path: string): string | null {
  if (!existsSync(path) || isLegacyDatabase(path)) return null;
  const db = new Database(path, { readonly: true });
  try {
    return readSetting(db, CONFIG_SETTINGS_KEY);
  } finally {
    db.close();
  }
}
