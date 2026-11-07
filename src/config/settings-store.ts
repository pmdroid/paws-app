import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export type SettingsStore = {
  read(): string | null;
  update(change: (stored: string | null) => string): void;
};

const stores = new Map<string, SettingsStore>();

export function useSettingsStore(configPath: string, store: SettingsStore): () => void {
  stores.set(configPath, store);
  return () => {
    if (stores.get(configPath) === store) stores.delete(configPath);
  };
}

export function readConfigText(configPath: string): string {
  const file = readFileText(configPath);
  const stored = stores.get(configPath)?.read() ?? null;
  return stored === null ? file : withSettings(file, stored);
}

export function updateConfigText(configPath: string, change: (current: string) => string): void {
  const store = stores.get(configPath);
  if (store === undefined) {
    replaceConfigText(configPath, change(readFileText(configPath)));
    return;
  }
  store.update((stored) => {
    const file = readFileText(configPath);
    return settingsSections(change(stored === null ? file : withSettings(file, stored)));
  });
}

function replaceConfigText(path: string, next: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const mode = existsSync(path) ? statSync(path).mode & 0o600 : 0o600;
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(temp, next, { mode });
    chmodSync(temp, mode);
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

function readFileText(configPath: string): string {
  return existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
}

function isSettingsSection(section: string): boolean {
  const name = section.toLowerCase();
  const within = (prefix: string) => name === prefix || name.startsWith(`${prefix}.`);
  return (
    name === "agents" ||
    within("agents.defaults") ||
    within("agents.projects") ||
    within("merge") ||
    name === "queue" ||
    within("time_limits") ||
    within("checkout.projects") ||
    within("brief")
  );
}

function splitSections(text: string, keep: (settings: boolean) => boolean): string {
  let settings = false;
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const heading = /^\s*\[\[?\s*([^[\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
      if (heading?.[1]) settings = isSettingsSection(heading[1]);
      return keep(settings);
    })
    .join("\n")
    .trim();
}

function settingsSections(text: string): string {
  const sections = splitSections(text, (settings) => settings);
  return sections === "" ? "" : `${sections}\n`;
}

function withSettings(file: string, stored: string): string {
  const retained = splitSections(file, (settings) => !settings);
  return [retained, stored.trim()].filter((part) => part !== "").join("\n\n") + "\n";
}
