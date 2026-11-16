import type { SettingsPage } from "./settings-pages";

const loads = new Map<SettingsPage, (() => void)[]>();
let shown: SettingsPage | null = null;

export function loadWhenShown(page: SettingsPage, load: () => void): void {
  if (page === shown) return load();
  loads.set(page, [...(loads.get(page) ?? []), load]);
}

export function settingsPageShown(page: SettingsPage | null): void {
  shown = page;
  if (page === null) return;
  const pending = loads.get(page) ?? [];
  loads.delete(page);
  for (const load of pending) load();
}

export function clearSettingsLoads(): void {
  loads.clear();
  shown = null;
}
