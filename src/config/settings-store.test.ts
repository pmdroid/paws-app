import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfigFile, parseConfigToml } from "./file";
import { readProjectMemorySettings, setProjectMemorySettingsText } from "./project-memory";
import {
  readConfigText,
  retiredConfigSections,
  updateConfigText,
  useMemorySettings,
  useMemorySettingsByDefault,
  useSettingsStore,
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
  "project_memory",
  "time_limits",
  `checkout.projects.${PROJECT}`,
  `closeout.projects.${PROJECT}`,
  "brief",
  "skills",
  `skills.projects.${PROJECT}`,
  "github_access",
  "findings",
  "member_vm",
  "linear_comments",
];
const BODIES: Record<string, string> = {
  "agents.defaults.implementer": 'agent = "claude"',
  "agents.defaults.reviewer": 'agent = "codex"',
  "agents.presets.fast.implementer": 'agent = "claude"',
  "agents.presets.fast.reviewer": 'agent = "codex"',
  [`skills.projects.${PROJECT}`]: 'root = ".agents/skills"',
  project_memory: "work_summary = true\ndream = false",
};

async function storedSettings(initial: string | null) {
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
  for (const name of WRITER_SECTIONS) expect(saved).toContain(`[${name}]`);
  expect(saved).not.toContain("[agents.grok]");
  expect(() => parseConfigToml(saved)).not.toThrow();
  expect(retiredConfigSections(configPath)).toEqual([]);
});

test("a config.toml on disk is never read or written", async () => {
  const { configPath, stored } = await storedSettings("[merge]\nci_fix_attempts = 4\n");
  writeFileSync(configPath, '[linear]\nteam = "ACME"\n\n[merge]\nci_fix_attempts = 9\n');
  expect(readConfigText(configPath)).toBe("[merge]\nci_fix_attempts = 4\n");
  await updateConfigText(configPath, (current) =>
    setProjectMemorySettingsText(current, { workSummary: true, dream: false, decisions: false }),
  );
  expect(stored()).toContain("[project_memory]");
  expect(readFileSync(configPath, "utf8")).toBe(
    '[linear]\nteam = "ACME"\n\n[merge]\nci_fix_attempts = 9\n',
  );
});

test("a save does not create a file", async () => {
  const configPath = join(tmpdir(), `paws-memory-${crypto.randomUUID()}`, "config.toml");
  const settings = await useSettingsStore(configPath, {
    read: async () => null,
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

test("project memory defaults off and round-trips through the stored settings", async () => {
  expect(readProjectMemorySettings(parseConfigToml(""))).toEqual({
    workSummary: false,
    dream: false,
    decisions: false,
  });
  expect(() => parseConfigToml("[project_memory]\nsummary = true\n")).toThrow("unknown key");
  const { configPath, stored } = await storedSettings(null);
  const written = setProjectMemorySettingsText("[merge]\nci_fix_attempts = 4\n", {
    workSummary: true,
    dream: true,
    decisions: true,
  });
  expect(readProjectMemorySettings(parseConfigToml(written))).toEqual({
    workSummary: true,
    dream: true,
    decisions: true,
  });
  await updateConfigText(configPath, (current) =>
    setProjectMemorySettingsText(current, { workSummary: false, dream: true, decisions: true }),
  );
  expect(stored()).toContain(
    "[project_memory]\nwork_summary = false\ndream = true\ndecisions = true\n",
  );
  expect(existsSync(configPath)).toBe(false);
  expect(readProjectMemorySettings(loadConfigFile(configPath))).toEqual({
    workSummary: false,
    dream: true,
    decisions: true,
  });
});

test("a save drops a retired section the stored settings still hold", async () => {
  const { configPath, stored } = await storedSettings(
    '[agents]\nimplementer = "codex"\n\n[agents.grok]\npath = "/usr/bin/grok"\n',
  );
  expect(loadConfigFile(configPath).agents.implementer).toBe("codex");
  await updateConfigText(configPath, (current) => current);
  expect(stored()).toBe('[agents]\nimplementer = "codex"\n');
});

test("memory settings seed loadConfigFile with no file on disk and keep a save", async () => {
  const configPath = join(tmpdir(), `paws-memory-${crypto.randomUUID()}`, "config.toml");
  const settings = useMemorySettings(configPath, '[agents]\nimplementer = "codex"\n');
  cleanups.push(() => settings.release());
  expect(loadConfigFile(configPath).agents.implementer).toBe("codex");
  await updateConfigText(configPath, (current) =>
    setProjectMemorySettingsText(current, { workSummary: true, dream: false, decisions: true }),
  );
  expect(readConfigText(configPath)).toContain("[project_memory]\nwork_summary = true");
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
