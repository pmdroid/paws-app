import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfigFile, parseConfigToml } from "./file";
import { retiredConfigSections, updateConfigText, useSettingsStore } from "./settings-store";

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
  writeFileSync(configPath, '[linear]\nteam = "ACME"\n');
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
  expect(loadConfigFile(configPath).linearTeam).toBe("ACME");
  expect(retiredConfigSections(configPath)).toEqual([]);
});

test("a save drops a retired section the stored settings still hold", async () => {
  const { configPath, stored } = await storedSettings(
    '[agents]\nimplementer = "codex"\n\n[agents.grok]\npath = "/usr/bin/grok"\n',
  );
  expect(loadConfigFile(configPath).agents.implementer).toBe("codex");
  await updateConfigText(configPath, (current) => current);
  expect(stored()).toBe('[agents]\nimplementer = "codex"\n\n[member_vm]\n');
});
