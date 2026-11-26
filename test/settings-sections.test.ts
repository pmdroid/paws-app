import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  configSettingsSections,
  loadConfigFile,
  parseBriefTemplates,
  parseConfigToml,
  readConfigText,
  SETTINGS_SECTIONS,
  useSettingsStore,
  writeFindingsGroupingTime,
} from "../src/config";
import {
  CONFIG_SETTINGS_KEY,
  convertConfigSettingsSteps,
  readSetting,
  updateSetting,
  updateSettingSectionsSteps,
  type Db,
} from "../src/db";
import { handleTimeLimitSettingsRequest } from "../src/settings";
import { tempHome } from "./helpers";
import { tempStore } from "./pglite";
import { sectionSettings } from "./saved-settings";

const KNOWN = `[github_access]
agent_read = false
mirrors = true

[closeout.projects."acme/app"]
policy_root = "policies"

[merge]
order = "ci-green"
ci_fix_attempts = 4

[merge.repositories."acme/app"]
packages = ["apps/*"]

[queue]
start_timeout_hours = 12

[findings]
grouping_time = "07:30"

[agents]
implementer = "codex"

[agents.defaults.implementer]
agent = "claude"
model = "implement-model"

[member_vm]
cpu = 2
image = "ubuntu:24.04"

[issue_vm]
per_member = 2

[brief]
template = "Summarise the issue.\\nKeep it short.\\n"

[linear_comments]
agents = ["claude"]

[time_limits]
implementation_minutes = 45

[skills.projects."acme/app"]
root = ".agents/skills"

[checkout.projects."acme/app"]
exclude = ["node_modules"]
`;

const EVERY_SECTION = `${KNOWN}\n[project_memory]\nwork_summary = true\n`;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function database(): Promise<Db> {
  const { db, close } = await tempStore();
  cleanups.push(close);
  return db;
}

function convert(db: Db) {
  return db.transaction((q) =>
    convertConfigSettingsSteps(q, SETTINGS_SECTIONS, configSettingsSections),
  );
}

async function rows(db: Db) {
  const stored = await db.run((q) => q.all(q.orm.select().from(q.t.setting)));
  return Object.fromEntries(stored.map((row) => [row.key, row]));
}

async function open(db: Db) {
  const home = tempHome();
  const configPath = join(home, "config.toml");
  const settings = await useSettingsStore(configPath, sectionSettings(db));
  cleanups.push(() => {
    settings.release();
    rmSync(home, { recursive: true, force: true });
  });
  return configPath;
}

test("a blob with every section converts to one row per section with the same values", async () => {
  const db = await database();
  await updateSetting(db, CONFIG_SETTINGS_KEY, () => EVERY_SECTION, 1);
  expect(await convert(db)).toBe(true);
  const stored = await rows(db);
  expect(stored[CONFIG_SETTINGS_KEY]).toBeUndefined();
  expect(Object.keys(stored).sort()).toEqual(
    SETTINGS_SECTIONS.map((name) => `settings.${name}`).sort(),
  );
  const parsed = Bun.TOML.parse(EVERY_SECTION) as Record<string, unknown>;
  for (const name of SETTINGS_SECTIONS)
    expect(JSON.parse(stored[`settings.${name}`]!.value)).toEqual(parsed[name]);
  expect(loadConfigFile(await open(db))).toEqual(parseConfigToml(KNOWN));
  expect(await convert(db)).toBe(false);
});

test("a blob that does not parse stops the conversion with its line and stays in place", async () => {
  const db = await database();
  const broken =
    '[merge]\norder = "queue"\n\n[project_memory]\nnote = 1\n\n[queue]\nstart_timeout_hours =\n';
  await updateSetting(db, CONFIG_SETTINGS_KEY, () => broken, 1);
  await expect(convert(db)).rejects.toThrow("Saved settings line 8 is not a key");
  expect(await readSetting(db, CONFIG_SETTINGS_KEY)).toBe(broken);
  expect(Object.keys(await rows(db))).toEqual([CONFIG_SETTINGS_KEY]);
});

test("startup without a blob writes nothing", async () => {
  const db = await database();
  expect(await convert(db)).toBe(false);
  expect(await rows(db)).toEqual({});
});

test("saving through a settings route writes only its section row", async () => {
  const db = await database();
  await updateSetting(db, CONFIG_SETTINGS_KEY, () => EVERY_SECTION, 1);
  await convert(db);
  const before = await rows(db);
  const configPath = await open(db);
  const response = await handleTimeLimitSettingsRequest(
    new Request("http://127.0.0.1:8787/api/settings/time-limits", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-paws-csrf": "csrf" },
      body: JSON.stringify({
        default: { implementationMinutes: 30, fixesMinutes: 0, closeoutMinutes: 0 },
      }),
    }),
    { configPath, csrfToken: "csrf", role: "admin", audit: async () => {} },
  );
  expect(response?.status).toBe(200);
  const after = await rows(db);
  const changed = Object.keys(after).filter(
    (key) => JSON.stringify(after[key]) !== JSON.stringify(before[key]),
  );
  expect(changed).toEqual(["settings.time_limits"]);
  expect(loadConfigFile(configPath).timeLimits?.implementationMinutes).toBe(30);
});

test("a section heading in another case converts to its section row", async () => {
  const db = await database();
  await updateSetting(db, CONFIG_SETTINGS_KEY, () => "[GitHub_Access]\nagent_read = false\n", 1);
  await convert(db);
  const stored = await rows(db);
  expect(JSON.parse(stored["settings.github_access"]!.value)).toEqual({ agent_read: false });
  expect(stored[CONFIG_SETTINGS_KEY]).toBeUndefined();
  expect(loadConfigFile(await open(db)).githubAccess).toEqual({ agentRead: false });
});

test("a TOML syntax error stops the conversion with its line and stays in place", async () => {
  const db = await database();
  const broken = "[brief]\ntemplate = ]\n";
  await updateSetting(db, CONFIG_SETTINGS_KEY, () => broken, 1);
  await expect(convert(db)).rejects.toThrow("Saved settings line 2 could not be read");
  expect(await readSetting(db, CONFIG_SETTINGS_KEY)).toBe(broken);
});

test("a string with a DEL character reads back after a save", async () => {
  const db = await database();
  await db.transaction((q) =>
    updateSettingSectionsSteps(q, SETTINGS_SECTIONS, (stored) => ({
      ...stored,
      brief: { template: "Keep\u007f short." },
    })),
  );
  const reopened = await open(db);
  expect(readConfigText(reopened)).toContain("\\u007f");
  expect(parseBriefTemplates(readConfigText(reopened)).template).toBe("Keep\u007f short.");
  await writeFindingsGroupingTime(reopened, "08:00");
  expect(loadConfigFile(reopened).findingsGroupingTime).toBe("08:00");
  expect(JSON.parse((await rows(db))["settings.brief"]!.value)).toEqual({
    template: "Keep\u007f short.",
  });
});
