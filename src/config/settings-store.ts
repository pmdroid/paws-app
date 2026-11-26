export type SettingSections = Record<string, unknown>;

export type SettingsStore = {
  read(): Promise<SettingSections>;
  update(change: (stored: SettingSections) => SettingSections): Promise<void>;
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

type Snapshot = { store: SettingsStore; stored: SettingSections; ticket: number };

const snapshots = new Map<string, Snapshot>();
let tickets = 0;
export async function useSettingsStore(
  home: string,
  store: SettingsStore,
): Promise<SettingsSnapshot> {
  const ticket = ++tickets;
  const snapshot: Snapshot = { store, stored: await store.read(), ticket };
  snapshots.set(home, snapshot);
  return {
    async refresh() {
      const started = ++tickets;
      const stored = await store.read();
      if (started < snapshot.ticket) return;
      snapshot.stored = stored;
      snapshot.ticket = started;
    },
    release() {
      if (snapshots.get(home) === snapshot) snapshots.delete(home);
    },
  };
}

export function savedSettingsSections(text: string, check: (known: string) => void) {
  const lines = knownConfigLines(text);
  try {
    check(lines);
    return settingsSectionsOf(lines);
  } catch (error) {
    const line = unreadableLine(lines);
    if (line === null) throw error;
    throw new Error(`Saved settings line ${line} could not be read: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

export function tomlSettingSections(text: string): SettingSections {
  return Object.fromEntries(
    Object.entries(Bun.TOML.parse(text) as SettingSections).map(([name, value]) => [
      name.toLowerCase(),
      value,
    ]),
  );
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

export function useMemorySettings(home: string, text?: string): { release(): void } {
  let stored = text === undefined ? {} : settingsSectionsOf(text);
  const store: SettingsStore = {
    read: async () => stored,
    update: async (change) => {
      stored = change(stored);
    },
  };
  const snapshot: Snapshot = { store, stored, ticket: ++tickets };
  snapshots.set(home, snapshot);
  return {
    release() {
      if (snapshots.get(home) === snapshot) snapshots.delete(home);
    },
  };
}

let memoryByDefault = false;

export function useMemorySettingsByDefault(enabled = true): void {
  memoryByDefault = enabled;
}

function snapshotOf(home: string): Snapshot | undefined {
  if (!snapshots.has(home) && memoryByDefault) useMemorySettings(home);
  return snapshots.get(home);
}

export function readSettingSections(home: string): SettingSections {
  return snapshotOf(home)?.stored ?? {};
}

export async function updateSettingSections(
  home: string,
  change: (stored: SettingSections) => SettingSections,
): Promise<void> {
  const snapshot = snapshotOf(home);
  if (snapshot === undefined)
    throw new Error("Settings are not available: the database is not open");
  let saved: SettingSections = {};
  await snapshot.store.update((stored) => (saved = change(stored)));
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

function knownLine(section: string): boolean {
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

type Keep = (section: string) => boolean;

function splitSections(text: string, keep: Keep): string {
  return keptLines(text, keep)
    .filter((line) => line !== null)
    .join("\n")
    .trim();
}

function keptLines(text: string, keep: Keep): (string | null)[] {
  let section = "";
  let open: string | null = null;
  return text.split(/\r?\n/).map((line) => {
    const heading = open === null ? /^\s*\[\[?\s*([^[\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line) : null;
    if (heading?.[1]) section = heading[1];
    open = openStringAfter(line, open);
    return keep(section) ? line : null;
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
