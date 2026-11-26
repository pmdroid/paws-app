import { renderSettingsToml, SETTINGS_SECTIONS, settingsSectionsOf } from "../src/config";
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
