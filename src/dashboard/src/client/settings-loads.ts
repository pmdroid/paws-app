import type { SettingsPage } from "./settings-pages";

const loads = new Map<SettingsPage, (() => void)[]>();

export function loadWhenShown(page: SettingsPage, load: () => void): void {
  loads.set(page, [...(loads.get(page) ?? []), load]);
}

export function settingsPageShown(page: SettingsPage | null): void {
  if (page === null) return;
  const pending = loads.get(page) ?? [];
  loads.delete(page);
  for (const load of pending) load();
}

export function clearSettingsLoads(): void {
  loads.clear();
}
