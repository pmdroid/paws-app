import { journalCaught } from "../journal";
import { useSyncExternalStore } from "react";
import { NativeSelect } from "./ui/native-select";

export type Appearance = "system" | "light" | "dark";
const STORAGE_KEY = "paws.appearance";
const listeners = new Set<() => void>();
let preference: Appearance = "system";
let systemDark = false;

export function parseAppearance(value: string | null): Appearance {
  return value === "light" || value === "dark" ? value : "system";
}

export function resolveAppearance(value: Appearance, dark: boolean): "light" | "dark" {
  return value === "system" ? (dark ? "dark" : "light") : value;
}

function notify(): void {
  document.documentElement.classList.toggle(
    "dark",
    resolveAppearance(preference, systemDark) === "dark",
  );
  document.documentElement.classList.toggle(
    "light",
    resolveAppearance(preference, systemDark) === "light",
  );
  for (const listener of listeners) listener();
}

export function initializeAppearance(): void {
  try {
    preference = parseAppearance(localStorage.getItem(STORAGE_KEY));
  } catch (caughtError1) {
    journalCaught(caughtError1, "appearance.initializeAppearance.parseAppearance", null);
    preference = "system";
  }
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  systemDark = media.matches;
  media.addEventListener("change", () => {
    systemDark = media.matches;
    notify();
  });
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    preference = parseAppearance(event.newValue);
    notify();
  });
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function AppearanceControl() {
  const value = useSyncExternalStore(
    subscribe,
    () => preference,
    () => "system" as const,
  );
  return (
    <label className="flex shrink-0 items-center gap-2 text-sm font-semibold">
      <span className="sr-only sm:not-sr-only">Appearance</span>
      <NativeSelect
        aria-label="Appearance"
        className="w-28"
        value={value}
        onChange={(event) => {
          preference = parseAppearance(event.currentTarget.value);
          try {
            localStorage.setItem(STORAGE_KEY, preference);
          } catch (caughtError2) {
            journalCaught(caughtError2, "appearance.AppearanceControl.setItem", null);
          }
          notify();
        }}
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </NativeSelect>
    </label>
  );
}
