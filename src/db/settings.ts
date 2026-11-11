import { eq } from "drizzle-orm";
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
