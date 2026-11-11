import { existsSync } from "node:fs";
import { loadRuntime, pawsPaths, useSettingsStore, type EnvSource } from "../config";
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
  const runtime = loadRuntime(env);
  const paths = pawsPaths(runtime.env.home);
  let opened: PawsStore | null = null;
  let settings: { release(): void } | null = null;
  try {
    opened = await openSaved(runtime.databaseUrl, paths.pgliteDir);
    const store = opened?.store;
    if (store)
      settings = await useSettingsStore(paths.configFile, {
        read: () => store.run((q) => readSettingSteps(q, CONFIG_SETTINGS_KEY)),
        update: (change) =>
          store.transaction((q) => updateSettingSteps(q, CONFIG_SETTINGS_KEY, change)),
      });
  } catch (error) {
    await opened?.close().catch(() => undefined);
    if (error instanceof PgliteInUseError) return work({ store: null, held: true });
    journalCaught(error, "doctor.withSavedStore.open", null);
    return work({ store: null, held: false });
  }
  try {
    return await work({ store: opened?.store ?? null, held: false });
  } finally {
    settings?.release();
    await opened?.close();
  }
}
