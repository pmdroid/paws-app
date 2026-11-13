import { existsSync } from "node:fs";
import { databaseUrlOf, loadEnv, pawsPaths, useSettingsStore, type EnvSource } from "../config";
import {
  CONFIG_SETTINGS_KEY,
  openPawsStore,
  openPostgres,
  PgliteInUseError,
  postgresDb,
  readSettingSteps,
  updateSettingSteps,
  type Db,
  type PawsStore,
} from "../db";
import { storedSecrets, useDatabaseSecrets } from "../credentials";
import { journalCaught } from "../journal";

export const DATABASE_HELD =
  "saved Settings-page values were not read because Paws holds the database; using config.toml";

export type SavedStore = { store: Db | null; held: boolean };

async function openSaved(url: string | null, pgliteDir: string): Promise<PawsStore | null> {
  if (url !== null) {
    const db = openPostgres(url);
    return { store: postgresDb(db), close: () => db.$client.close() };
  }
  if (!existsSync(pgliteDir)) return null;
  return openPawsStore({ url: null, pgliteDir });
}

export async function withSavedStore<T>(
  env: EnvSource,
  work: (saved: SavedStore) => Promise<T>,
): Promise<T> {
  const paths = pawsPaths(loadEnv(env).home);
  let databaseUrl: string | null = null;
  try {
    databaseUrl = databaseUrlOf(env);
  } catch (error) {
    journalCaught(error, "doctor.withSavedStore.databaseUrl", null);
  }
  let opened: PawsStore | null = null;
  let settings: { release(): void } | null = null;
  let secrets: { close(): Promise<void> } | null = null;
  try {
    opened = await openSaved(databaseUrl, paths.pgliteDir);
    const store = opened?.store;
    if (store && databaseUrl !== null && storedSecrets() === null)
      secrets = await useDatabaseSecrets(store, paths.secretsDir, { copy: false });
    if (store)
      settings = await useSettingsStore(paths.configFile, {
        read: () => store.run((q) => readSettingSteps(q, CONFIG_SETTINGS_KEY)),
        update: (change) =>
          store.transaction((q) => updateSettingSteps(q, CONFIG_SETTINGS_KEY, change)),
      });
  } catch (error) {
    await secrets?.close().catch(() => undefined);
    await opened?.close().catch(() => undefined);
    if (error instanceof PgliteInUseError) return work({ store: null, held: true });
    journalCaught(error, "doctor.withSavedStore.open", null);
    return work({ store: null, held: false });
  }
  try {
    return await work({ store: opened?.store ?? null, held: false });
  } finally {
    settings?.release();
    await secrets?.close();
    await opened?.close();
  }
}
