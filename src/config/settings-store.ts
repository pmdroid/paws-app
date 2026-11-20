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

export function useMemorySettings(configPath: string, text?: string): { release(): void } {
  let stored = text ?? null;
  const store: SettingsStore = {
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
    /^(github_access|closeout|merge|queue|project_memory|findings|agents|member_vm|brief|linear_comments|time_limits|skills)$/.test(
      section,
    ) ||
    /^(closeout|merge|checkout|skills|brief|time_limits)\./.test(section) ||
    /^agents\.(defaults|projects|presets)(\.|$)/.test(section)
  );
}

function knownSections(text: string): string {
  return splitSections(
    text,
    (_settings, _heading, section) => section === "" || knownConfigSection(section.toLowerCase()),
  );
}

export function retiredConfigSections(configPath: string): string[] {
  const stored = snapshotOf(configPath)?.stored ?? null;
  const sections = new Set<string>();
  splitSections(stored ?? "", (_settings, heading) => {
    if (heading !== undefined && !knownConfigSection(heading.toLowerCase()))
      sections.add(heading.toLowerCase());
    return false;
  });
  return [...sections];
}

export function describeRetiredSections(sections: readonly string[]): string {
  return `Saved settings ${sections.map((name) => `[${name}]`).join(", ")} ${sections.length === 1 ? "is" : "are"} not known to this Paws and ${sections.length === 1 ? "is" : "are"} ignored: remove ${sections.length === 1 ? "it" : "them"} in Settings`;
}

export async function removeRetiredConfigSection(configPath: string, name: string): Promise<void> {
  const snapshot = snapshotOf(configPath);
  const section = name.toLowerCase();
  if (snapshot === undefined || !retiredConfigSections(configPath).includes(section)) return;
  let saved = "";
  await snapshot.store.update((stored) => {
    const kept = withoutConfigSection(stored ?? "", section);
    saved = kept === "" ? "" : `${kept}\n`;
    return saved;
  });
  snapshot.stored = saved;
  snapshot.ticket = ++tickets;
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
    name === "project_memory" ||
    within("time_limits") ||
    within("checkout.projects") ||
    within("closeout.projects") ||
    within("brief") ||
    within("skills") ||
    name === "github_access" ||
    name === "findings" ||
    name === "member_vm" ||
    name === "linear_comments"
  );
}

export function withoutConfigSection(text: string, name: string): string {
  return splitSections(text, (_settings, _heading, section) => section.toLowerCase() !== name);
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

function settingsSections(text: string): string {
  const sections = splitSections(
    text,
    (settings, _heading, section) => settings && knownConfigSection(section.toLowerCase()),
  );
  return sections === "" ? "" : `${sections}\n`;
}
