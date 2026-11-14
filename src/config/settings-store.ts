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
  read(): Promise<string | null>;
  update(change: (stored: string | null) => string): Promise<void>;
};

type SettingsSnapshot = {
  refresh(): Promise<void>;
  release(): void;
};

type Snapshot = { store: SettingsStore; stored: string | null; ticket: number };

const snapshots = new Map<string, Snapshot>();
let tickets = 0;
export async function useSettingsStore(
  configPath: string,
  store: SettingsStore,
): Promise<SettingsSnapshot> {
  const ticket = ++tickets;
  const snapshot: Snapshot = { store, stored: await store.read(), ticket };
  snapshots.set(configPath, snapshot);
  return {
    async refresh() {
      const started = ++tickets;
      const stored = await store.read();
      if (started < snapshot.ticket) return;
      snapshot.stored = stored;
      snapshot.ticket = started;
    },
    release() {
      if (snapshots.get(configPath) === snapshot) snapshots.delete(configPath);
    },
  };
}

export function readConfigText(configPath: string): string {
  const file = readFileText(configPath);
  const stored = storedSettings(configPath);
  return stored === null ? file : withSettings(file, stored);
}

export function updateConfigText(
  configPath: string,
  change: (current: string) => string,
): Promise<void> {
  const snapshot = snapshots.get(configPath);
  if (snapshot === undefined) {
    replaceConfigText(configPath, change(readFileText(configPath)));
    return Promise.resolve();
  }
  return saveSettings(configPath, snapshot, change);
}

async function saveSettings(
  configPath: string,
  snapshot: Snapshot,
  change: (current: string) => string,
): Promise<void> {
  let saved = "";
  await snapshot.store.update((stored) => {
    const file = readFileText(configPath);
    saved = withOwnedSections(
      settingsSections(change(stored === null ? file : withSettings(file, stored))),
    );
    return saved;
  });
  snapshot.stored = saved;
  snapshot.ticket = ++tickets;
}

export function overriddenConfigSections(configPath: string): string[] {
  const stored = storedSettings(configPath);
  if (stored === null) return [];
  const fromFile = keptFromFile(stored);
  const sections = new Set<string>();
  splitSections(readFileText(configPath), (settings, heading) => {
    if (settings && heading !== undefined && !fromFile(heading)) sections.add(heading);
    return false;
  });
  return [...sections];
}

export function describeOverriddenSections(sections: readonly string[]): string {
  return `config.toml ${sections.map((name) => `[${name}]`).join(", ")} ${sections.length === 1 ? "is" : "are"} ignored: the Settings page saved ${sections.length === 1 ? "this section" : "these sections"} to the database, which wins`;
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

function storedSettings(configPath: string): string | null {
  return snapshots.get(configPath)?.stored ?? null;
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
    within("agents.presets") ||
    within("agents.grok") ||
    within("agents.opencode") ||
    within("merge") ||
    name === "queue" ||
    within("time_limits") ||
    within("checkout.projects") ||
    within("closeout.projects") ||
    within("brief") ||
    within("skills") ||
    name === "github_access" ||
    name === "member_vm"
  );
}

const FILE_UNTIL_SAVED = ["agents.grok", "agents.opencode"];

function familyOf(section: string): string | undefined {
  const name = section.trim().toLowerCase();
  return FILE_UNTIL_SAVED.find((prefix) => name === prefix || name.startsWith(`${prefix}.`));
}

function keptFromFile(stored: string): (section: string) => boolean {
  const saved = new Set<string>();
  splitSections(stored, (_settings, heading) => {
    const family = heading === undefined ? undefined : familyOf(heading);
    if (family !== undefined) saved.add(family);
    return false;
  });
  return (section) => {
    const family = familyOf(section);
    return family !== undefined && !saved.has(family);
  };
}

function splitSections(
  text: string,
  keep: (settings: boolean, heading: string | undefined, section: string) => boolean,
): string {
  let settings = false;
  let section = "";
  let open: string | null = null;
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const heading =
        open === null ? /^\s*\[\[?\s*([^[\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line) : null;
      if (heading?.[1]) {
        settings = isSettingsSection(heading[1]);
        section = heading[1];
      }
      open = openStringAfter(line, open);
      return keep(settings, heading?.[1], section);
    })
    .join("\n")
    .trim();
}

function openStringAfter(line: string, start: string | null): string | null {
  let open = start;
  let index = 0;
  while (index < line.length) {
    if (open !== null) {
      if (open === '"""' && line[index] === "\\") index += 2;
      else if (line.startsWith(open, index)) {
        index += 3;
        open = null;
      } else index += 1;
      continue;
    }
    const char = line[index];
    if (char === "#") return null;
    const triple = line.slice(index, index + 3);
    if (triple === '"""' || triple === "'''") {
      open = triple;
      index += 3;
    } else if (char === '"' || char === "'") {
      index += 1;
      while (index < line.length && line[index] !== char)
        index += char === '"' && line[index] === "\\" ? 2 : 1;
      index += 1;
    } else index += 1;
  }
  return open;
}

function withOwnedSections(saved: string): string {
  const fromFile = keptFromFile(saved);
  const missing = FILE_UNTIL_SAVED.filter((family) => fromFile(family));
  return [saved.trim(), ...missing.map((family) => `[${family}]`)]
    .filter((part) => part !== "")
    .join("\n\n")
    .concat("\n");
}

function settingsSections(text: string): string {
  const sections = splitSections(text, (settings) => settings);
  return sections === "" ? "" : `${sections}\n`;
}

function withSettings(file: string, stored: string): string {
  const fromFile = keptFromFile(stored);
  const retained = splitSections(
    file,
    (settings, _heading, section) => !settings || fromFile(section),
  );
  return [retained, stored.trim()].filter((part) => part !== "").join("\n\n") + "\n";
}
