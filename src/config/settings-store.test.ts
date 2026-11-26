import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfigFile, parseConfigToml } from "./file";
import {
  readConfigText,
  updateConfigText,
  useMemorySettings,
  useMemorySettingsByDefault,
  useSettingsStore,
  renderSettingsToml,
  settingsSectionsOf,
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
  "member_vm",
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

async function storedSettings(initial: string | null) {
  const home = mkdtempSync(join(tmpdir(), "paws-settings-store-"));
  const configPath = join(home, "config.toml");
  let stored = initial;
  const settings = await useSettingsStore(configPath, {
    read: async () => settingsSectionsOf(stored ?? ""),
    update: async (change) => {
      stored = renderSettingsToml(change(settingsSectionsOf(stored ?? "")));
    },
  });
  cleanups.push(() => {
    settings.release();
    rmSync(home, { recursive: true, force: true });
  });
  return { configPath, stored: () => stored };
}

test("every section the settings writer emits parses again", async () => {
  const { configPath, stored } = await storedSettings(null);
  await updateConfigText(configPath, (current) =>
    [
      current,
      ...WRITER_SECTIONS.map((name) => `[${name}]\n${BODIES[name] ?? ""}`),
      "[agents.grok]",
    ].join("\n\n"),
  );
  const saved = stored() ?? "";
  expect(Object.keys(settingsSectionsOf(saved)).sort()).toEqual(
    [...new Set(WRITER_SECTIONS.map((name) => name.replace(/\..*/, "")))].sort(),
  );
  expect(saved).not.toContain("[agents.grok]");
  expect(() => parseConfigToml(saved)).not.toThrow();
});

test("a config.toml on disk is never read or written", async () => {
  const { configPath, stored } = await storedSettings("[merge]\nci_fix_attempts = 4\n");
  writeFileSync(configPath, '[linear]\nteam = "ACME"\n\n[merge]\nci_fix_attempts = 9\n');
  expect(readConfigText(configPath)).toBe("[merge]\nci_fix_attempts = 4\n");
  await updateConfigText(
    configPath,
    (current) => `${current}\n[queue]\nstart_timeout_hours = 12\n`,
  );
  expect(stored()).toContain("[queue]\nstart_timeout_hours = 12");
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
  await updateConfigText(configPath, () => "[queue]\nstart_timeout_hours = 2\n");
  expect(existsSync(configPath)).toBe(false);
});

test("with no store and no default store, a save rejects and nothing is kept", async () => {
  const configPath = join(tmpdir(), `paws-memory-${crypto.randomUUID()}`, "config.toml");
  useMemorySettingsByDefault(false);
  try {
    expect(readConfigText(configPath)).toBe("");
    await expect(
      updateConfigText(configPath, () => "[queue]\nstart_timeout_hours = 2\n"),
    ).rejects.toThrow("Settings are not available: the database is not open");
    expect(readConfigText(configPath)).toBe("");
    expect(existsSync(configPath)).toBe(false);
  } finally {
    useMemorySettingsByDefault();
  }
});

test("a stored unknown section is not read and is gone after any save", async () => {
  const { configPath, stored } = await storedSettings(
    "[merge]\nci_fix_attempts = 4\n\n[project_memory]\nwork_summary = true\n",
  );
  expect(readConfigText(configPath)).toBe("[merge]\nci_fix_attempts = 4\n");
  await updateConfigText(configPath, (current) => current);
  expect(stored()).toBe("[merge]\nci_fix_attempts = 4\n");
});

test("memory settings seed loadConfigFile with no file on disk and keep a save", async () => {
  const configPath = join(tmpdir(), `paws-memory-${crypto.randomUUID()}`, "config.toml");
  const settings = useMemorySettings(configPath, '[agents]\nimplementer = "codex"\n');
  cleanups.push(() => settings.release());
  expect(loadConfigFile(configPath).agents.implementer).toBe("codex");
  await updateConfigText(
    configPath,
    (current) => `${current}\n[queue]\nstart_timeout_hours = 12\n`,
  );
  expect(readConfigText(configPath)).toContain("[queue]\nstart_timeout_hours = 12");
  expect(readConfigText(configPath)).toContain('implementer = "codex"');
  expect(existsSync(configPath)).toBe(false);
});

test("releasing memory settings removes the registration", () => {
  const configPath = join(tmpdir(), `paws-memory-${crypto.randomUUID()}`, "config.toml");
  const settings = useMemorySettings(configPath, '[agents]\nimplementer = "codex"\n');
  settings.release();
  expect(readConfigText(configPath)).toBe("");
  expect(loadConfigFile(configPath).agents.implementer).not.toBe("codex");
});

test("memory settings without text start empty", () => {
  const configPath = join(tmpdir(), `paws-memory-${crypto.randomUUID()}`, "config.toml");
  const settings = useMemorySettings(configPath);
  cleanups.push(() => settings.release());
  expect(readConfigText(configPath)).toBe("");
});
