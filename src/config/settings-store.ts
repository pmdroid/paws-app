export type SettingSections = Record<string, unknown>;

export type SettingsStore = {
  read(): Promise<SettingSections>;
  update(change: (stored: SettingSections) => SettingSections): Promise<void>;
};

type TextStore = {
  read(): Promise<string | null>;
  update(change: (stored: string | null) => string): Promise<void>;
};

export const SETTINGS_SECTIONS = [
  "github_access",
  "closeout",
  "merge",
  "queue",
  "findings",
  "agents",
  "vm_sizes",
  "issue_vm",
  "brief",
  "linear_comments",
  "time_limits",
  "skills",
  "checkout",
] as const;

export const SAVED_SETTINGS_SECTIONS = [...SETTINGS_SECTIONS, "member_vm"];

type SettingsSnapshot = {
  refresh(): Promise<void>;
  release(): void;
};

type Snapshot = { store: TextStore; stored: string | null; ticket: number };

const snapshots = new Map<string, Snapshot>();
let tickets = 0;
export async function useSettingsStore(
  configPath: string,
  sections: SettingsStore,
): Promise<SettingsSnapshot> {
  const store: TextStore = {
    read: async () => renderSettingsToml(await sections.read()),
    update: (change) =>
      sections.update((stored) => settingsSectionsOf(change(renderSettingsToml(stored)))),
  };
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

export function savedSettingsSections(text: string, check: (known: string) => void) {
  const lines = knownConfigLines(text);
  try {
    check(lines);
    return settingsSectionsOf(lines);
  } catch (error) {
    const message = (error as Error).message;
    if (/^Saved settings line \d+/.test(message)) throw error;
    const line = unreadableLine(lines);
    throw new Error(
      `Saved settings${line === null ? "" : ` line ${line}`} could not be read: ${message}`,
      { cause: error },
    );
  }
}

function unreadableLine(text: string): number | null {
  const lines = text.split(/\r?\n/);
  let parsed = 0;
  for (let count = 1; count <= lines.length; count += 1)
    if (parsesAsToml(lines.slice(0, count).join("\n"))) parsed = count;
  return parsed === lines.length ? null : parsed + 1;
}

function parsesAsToml(text: string): boolean {
  try {
    Bun.TOML.parse(text);
    return true;
  } catch {
    return false;
  }
}

export function useMemorySettings(configPath: string, text?: string): { release(): void } {
  let stored = text ?? null;
  const store: TextStore = {
    read: async () => stored,
    update: async (change) => {
      stored = change(stored);
    },
  };
  const snapshot: Snapshot = { store, stored, ticket: ++tickets };
  snapshots.set(configPath, snapshot);
  return {
    release() {
      if (snapshots.get(configPath) === snapshot) snapshots.delete(configPath);
    },
  };
}

let memoryByDefault = false;

export function useMemorySettingsByDefault(enabled = true): void {
  memoryByDefault = enabled;
}

function snapshotOf(configPath: string): Snapshot | undefined {
  if (!snapshots.has(configPath) && memoryByDefault) useMemorySettings(configPath);
  return snapshots.get(configPath);
}

export function readConfigText(configPath: string): string {
  const stored = snapshotOf(configPath)?.stored ?? null;
  const known = stored === null ? "" : knownSections(stored);
  return known === "" ? "" : `${known}\n`;
}

export function updateConfigText(
  configPath: string,
  change: (current: string) => string,
): Promise<void> {
  const snapshot = snapshotOf(configPath);
  if (snapshot === undefined)
    return Promise.reject(new Error("Settings are not available: the database is not open"));
  return saveSettings(snapshot, change);
}

async function saveSettings(
  snapshot: Snapshot,
  change: (current: string) => string,
): Promise<void> {
  let saved = "";
  await snapshot.store.update((stored) => {
    saved = settingsSections(change(stored === null ? "" : knownSections(stored)));
    return saved;
  });
  snapshot.stored = saved;
  snapshot.ticket = ++tickets;
}

export function knownConfigSection(section: string): boolean {
  return (
    /^(github_access|closeout|merge|queue|findings|agents|member_vm|vm_sizes|issue_vm|brief|linear_comments|time_limits|skills)$/.test(
      section,
    ) ||
    /^vm_sizes\.(exe-dev|boat|instabox)$/.test(section) ||
    /^(closeout|merge|checkout|skills|brief|time_limits)\./.test(section) ||
    /^agents\.(defaults|projects|presets)(\.|$)/.test(section)
  );
}

function knownSections(text: string): string {
  return splitSections(text, knownLine);
}

function knownLine(_settings: boolean, _heading: string | undefined, section: string): boolean {
  return section === "" || knownConfigSection(section.toLowerCase());
}

function knownConfigLines(text: string): string {
  return keptLines(text, knownLine)
    .map((line) => line ?? "")
    .join("\n");
}

export function settingsSectionsOf(text: string): SettingSections {
  const known = knownSections(text);
  const root = known === "" ? {} : (Bun.TOML.parse(known) as SettingSections);
  const sections: SettingSections = {};
  for (const [key, value] of Object.entries(root)) {
    const name = key.toLowerCase();
    if (!(SAVED_SETTINGS_SECTIONS as readonly string[]).includes(name)) continue;
    if (typeof value === "object" && value !== null && !Array.isArray(value))
      sections[name] = { ...(sections[name] as object | undefined), ...value };
  }
  return sections;
}

export function renderSettingsToml(sections: SettingSections): string {
  const out: string[] = [];
  for (const name of SETTINGS_SECTIONS)
    if (sections[name] !== undefined) renderTable(out, [name], sections[name], false);
  return out.length === 0 ? "" : `${out.join("\n").trim()}\n`;
}

function renderTable(out: string[], path: string[], value: unknown, item: boolean): void {
  const entries = Object.entries(value as Record<string, unknown>);
  const isTable = (entry: unknown) =>
    typeof entry === "object" && entry !== null && !Array.isArray(entry);
  const isTables = (entry: unknown) =>
    Array.isArray(entry) && entry.length > 0 && entry.every(isTable);
  const plain = entries.filter(([, entry]) => !isTable(entry) && !isTables(entry));
  const header = path.map(tomlKey).join(".");
  if (item) out.push("", `[[${header}]]`);
  else if (plain.length > 0 || entries.length === 0) out.push("", `[${header}]`);
  for (const [key, entry] of plain) out.push(`${tomlKey(key)} = ${tomlValue(entry)}`);
  for (const [key, entry] of entries) {
    if (isTable(entry)) renderTable(out, [...path, key], entry, false);
    else if (isTables(entry))
      for (const element of entry as unknown[]) renderTable(out, [...path, key], element, true);
  }
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlValue(key);
}

function tomlValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (typeof value === "string") return JSON.stringify(value).replaceAll("\x7f", "\\u007f");
  if (typeof value === "object" && value !== null)
    return `{ ${Object.entries(value)
      .map(([key, entry]) => `${tomlKey(key)} = ${tomlValue(entry)}`)
      .join(", ")} }`;
  return String(value);
}

function isSettingsSection(section: string): boolean {
  const name = section.toLowerCase();
  const within = (prefix: string) => name === prefix || name.startsWith(`${prefix}.`);
  return (
    name === "agents" ||
    within("agents.defaults") ||
    within("agents.projects") ||
    within("agents.presets") ||
    within("merge") ||
    name === "queue" ||
    within("time_limits") ||
    within("checkout.projects") ||
    within("closeout.projects") ||
    within("brief") ||
    within("skills") ||
    name === "github_access" ||
    name === "findings" ||
    name === "member_vm" ||
    within("vm_sizes") ||
    name === "issue_vm" ||
    name === "linear_comments"
  );
}

export function withoutConfigSection(text: string, name: string): string {
  return splitSections(text, (_settings, _heading, section) => section.toLowerCase() !== name);
}

type Keep = (settings: boolean, heading: string | undefined, section: string) => boolean;

function splitSections(text: string, keep: Keep): string {
  return keptLines(text, keep)
    .filter((line) => line !== null)
    .join("\n")
    .trim();
}

function keptLines(text: string, keep: Keep): (string | null)[] {
  let settings = false;
  let section = "";
  let open: string | null = null;
  return text.split(/\r?\n/).map((line) => {
    const heading = open === null ? /^\s*\[\[?\s*([^[\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line) : null;
    if (heading?.[1]) {
      settings = isSettingsSection(heading[1]);
      section = heading[1];
    }
    open = openStringAfter(line, open);
    return keep(settings, heading?.[1], section) ? line : null;
  });
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

function settingsSections(text: string): string {
  const sections = splitSections(
    text,
    (settings, _heading, section) => settings && knownConfigSection(section.toLowerCase()),
  );
  return sections === "" ? "" : `${sections}\n`;
}
