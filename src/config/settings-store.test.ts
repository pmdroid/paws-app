import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFromSections, loadSettings, saveSettingsSection } from "./file";
import {
  readSettingSections,
  useMemorySettings,
  useMemorySettingsByDefault,
  useSettingsStore,
  settingsSectionsOf,
  type SettingSections,
} from "./settings-store";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const PROJECT = '"acme/app"';
const WRITER_SECTIONS = [
  "agents",
  "agents.defaults",
  "agents.defaults.implementer",
  "agents.defaults.reviewer",
  `agents.projects.${PROJECT}`,
  "agents.presets.fast.implementer",
  "agents.presets.fast.reviewer",
  "merge",
  "merge.projects.abc",
  `merge.repositories.${PROJECT}`,
  "queue",
  "time_limits",
  `checkout.projects.${PROJECT}`,
  `closeout.projects.${PROJECT}`,
  "brief",
  "skills",
  `skills.projects.${PROJECT}`,
  "github_access",
  "findings",
  "vm_sizes",
  "vm_sizes.boat",
  "issue_vm",
  "linear_comments",
];
const BODIES: Record<string, string> = {
  "agents.defaults.implementer": 'agent = "claude"',
  "agents.defaults.reviewer": 'agent = "codex"',
  "agents.presets.fast.implementer": 'agent = "claude"',
  "agents.presets.fast.reviewer": 'agent = "codex"',
  [`skills.projects.${PROJECT}`]: 'root = ".agents/skills"',
};

async function storedSettings(initial: SettingSections) {
  const home = mkdtempSync(join(tmpdir(), "paws-settings-store-"));
  const configPath = join(home, "config.toml");
  let stored = initial;
  const settings = await useSettingsStore(configPath, {
    read: async () => stored,
    update: async (change) => {
      stored = change(stored);
    },
  });
  cleanups.push(() => {
    settings.release();
    rmSync(home, { recursive: true, force: true });
  });
  return { configPath, stored: () => stored };
}

test("every section the startup conversion keeps parses as typed sections", () => {
  const sections = settingsSectionsOf(
    [...WRITER_SECTIONS.map((name) => `[${name}]\n${BODIES[name] ?? ""}`), "[agents.grok]"].join(
      "\n\n",
    ),
  );
  expect(Object.keys(sections).sort()).toEqual(
    [...new Set(WRITER_SECTIONS.map((name) => name.replace(/\..*/, "")))].sort(),
  );
  expect(sections["agents"]).not.toHaveProperty("grok");
  expect(() => configFromSections(sections)).not.toThrow();
});

test("a config.toml on disk is never read or written", async () => {
  const { configPath, stored } = await storedSettings({ merge: { ci_fix_attempts: 4 } });
  writeFileSync(configPath, '[linear]\nteam = "ACME"\n\n[merge]\nci_fix_attempts = 9\n');
  expect(readSettingSections(configPath)).toEqual({ merge: { ci_fix_attempts: 4 } });
  await saveSettingsSection(configPath, "queue", { start_timeout_hours: 12 });
  expect(stored()).toEqual({ merge: { ci_fix_attempts: 4 }, queue: { start_timeout_hours: 12 } });
  expect(readFileSync(configPath, "utf8")).toBe(
    '[linear]\nteam = "ACME"\n\n[merge]\nci_fix_attempts = 9\n',
  );
});

test("a save does not create a file", async () => {
  const configPath = join(tmpdir(), `paws-memory-${crypto.randomUUID()}`, "config.toml");
  const settings = await useSettingsStore(configPath, {
    read: async () => ({}),
    update: async () => undefined,
  });
  cleanups.push(() => settings.release());
  await saveSettingsSection(configPath, "queue", { start_timeout_hours: 2 });
  expect(existsSync(configPath)).toBe(false);
});

test("with no store and no default store, a save rejects and nothing is kept", async () => {
  const configPath = join(tmpdir(), `paws-memory-${crypto.randomUUID()}`, "config.toml");
  useMemorySettingsByDefault(false);
  try {
    expect(readSettingSections(configPath)).toEqual({});
    await expect(
      saveSettingsSection(configPath, "queue", { start_timeout_hours: 2 }),
    ).rejects.toThrow("Settings are not available: the database is not open");
    expect(readSettingSections(configPath)).toEqual({});
    expect(existsSync(configPath)).toBe(false);
  } finally {
    useMemorySettingsByDefault();
  }
});

test("a save that fails its section's checks keeps the stored sections", async () => {
  const { configPath, stored } = await storedSettings({ merge: { ci_fix_attempts: 4 } });
  await expect(saveSettingsSection(configPath, "merge", { parallel: 9 })).rejects.toThrow(
    "Saved settings merge.parallel must be from 1 to 5",
  );
  expect(stored()).toEqual({ merge: { ci_fix_attempts: 4 } });
  expect(readSettingSections(configPath)).toEqual({ merge: { ci_fix_attempts: 4 } });
});

test("memory settings seed loadSettings with no file on disk and keep a save", async () => {
  const configPath = join(tmpdir(), `paws-memory-${crypto.randomUUID()}`, "config.toml");
  const settings = useMemorySettings(configPath, '[agents]\nimplementer = "codex"\n');
  cleanups.push(() => settings.release());
  expect(loadSettings(configPath).agents.implementer).toBe("codex");
  await saveSettingsSection(configPath, "queue", { start_timeout_hours: 12 });
  expect(readSettingSections(configPath)).toEqual({
    agents: { implementer: "codex" },
    queue: { start_timeout_hours: 12 },
  });
  expect(existsSync(configPath)).toBe(false);
});

test("releasing memory settings removes the registration", () => {
  const configPath = join(tmpdir(), `paws-memory-${crypto.randomUUID()}`, "config.toml");
  const settings = useMemorySettings(configPath, '[agents]\nimplementer = "codex"\n');
  settings.release();
  expect(readSettingSections(configPath)).toEqual({});
  expect(loadSettings(configPath).agents.implementer).not.toBe("codex");
});

test("memory settings without text start empty", () => {
  const configPath = join(tmpdir(), `paws-memory-${crypto.randomUUID()}`, "config.toml");
  const settings = useMemorySettings(configPath);
  cleanups.push(() => settings.release());
  expect(readSettingSections(configPath)).toEqual({});
});
