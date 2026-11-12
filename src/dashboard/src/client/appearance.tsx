import { journalCaught } from "../journal";
import { useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";
import { Button } from "./ui/button";

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

/** The theme a click on the toggle switches to. */
export function nextAppearance(resolved: "light" | "dark"): "light" | "dark" {
  return resolved === "dark" ? "light" : "dark";
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
  const resolved = useSyncExternalStore(
    subscribe,
    () => resolveAppearance(preference, systemDark),
    () => "dark" as const,
  );
  const label = resolved === "dark" ? "Switch to light theme" : "Switch to dark theme";
  const Icon = resolved === "dark" ? Sun : Moon;
  return (
    <Button
      type="button"
      variant="neutral"
      size="icon"
      aria-label={label}
      title={label}
      onClick={() => {
        preference = nextAppearance(resolved);
        try {
          localStorage.setItem(STORAGE_KEY, preference);
        } catch (caughtError2) {
          journalCaught(caughtError2, "appearance.AppearanceControl.setItem", null);
        }
        notify();
      }}
    >
      <Icon aria-hidden="true" />
    </Button>
  );
}
