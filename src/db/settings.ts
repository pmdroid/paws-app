import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { orm } from "./orm";
import { setting } from "./schema";
import { immediate } from "./tx";

export const CONFIG_SETTINGS_KEY = "config.toml";

export function readSetting(db: Database, key: string): string | null {
  return (
    orm(db).select({ value: setting.value }).from(setting).where(eq(setting.key, key)).get()
      ?.value ?? null
  );
}

export function updateSetting(
  db: Database,
  key: string,
  change: (stored: string | null) => string,
  now = Date.now(),
): void {
  immediate(db, () => {
    const value = change(readSetting(db, key));
    orm(db)
      .insert(setting)
      .values({ key, value, updatedAt: now })
      .onConflictDoUpdate({ target: setting.key, set: { value, updatedAt: now } })
      .run();
  });
}
