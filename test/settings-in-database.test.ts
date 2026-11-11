import { afterEach, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  describeOverriddenSections,
  loadConfigFile,
  overriddenConfigSections,
  loadRuntime,
  parseBriefTemplates,
  readConfigText,
  readMergeSettings,
  resolveAgentProfiles,
  useSettingsStore,
} from "../src/config";
import {
  CONFIG_SETTINGS_KEY,
  migrate,
  openDatabase,
  readSetting,
  readSettingSteps,
  sqliteDb,
  updateSetting,
  updateSettingSteps,
} from "../src/db";
import { useSavedSettings } from "../src/index";
import { handleTimeLimitSettingsRequest } from "../src/settings";
import { tempHome } from "./helpers";

const BOOTSTRAP = `[linear]
team = "ACME"

[caps]
max_awake_ms = 5400000

[merge]
order = "queue"
`;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function instance(dbPath: string, team: string) {
  const home = tempHome();
  const configPath = join(home, "config.toml");
  writeFileSync(configPath, BOOTSTRAP.replace("ACME", team));
  const db = openDatabase(dbPath);
  migrate(db);
  const store = sqliteDb(db);
  const settings = await useSettingsStore(configPath, {
    read: () => store.run((q) => readSettingSteps(q, CONFIG_SETTINGS_KEY)),
    update: (change) =>
      store.transaction((q) => updateSettingSteps(q, CONFIG_SETTINGS_KEY, change)),
  });
  cleanups.push(() => {
    settings.release();
    db.close();
    rmSync(home, { recursive: true, force: true });
  });
  return { db, configPath, refresh: settings.refresh };
}

function shared() {
  const dir = tempHome();
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "paws.db");
}

function saveTimeLimits(configPath: string, implementationMinutes: number) {
  return handleTimeLimitSettingsRequest(
    new Request("http://127.0.0.1:8787/api/settings/time-limits", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-paws-csrf": "csrf" },
      body: JSON.stringify({
        default: { implementationMinutes, fixesMinutes: 0, closeoutMinutes: 0 },
        projects: [],
      }),
    }),
    { configPath, csrfToken: "csrf", role: "admin", audit: async () => {} },
  );
}

test("an empty setting table reads config.toml as the bootstrap", async () => {
  const a = await instance(shared(), "ACME");
  expect(await readSetting(sqliteDb(a.db), CONFIG_SETTINGS_KEY)).toBe(null);
  expect(readMergeSettings(loadConfigFile(a.configPath)).default.order).toBe("queue");
  expect(loadConfigFile(a.configPath).linearTeam).toBe("ACME");
});

test("a setting saved on instance A is read by instance B after its next refresh", async () => {
  const dbPath = shared();
  const a = await instance(dbPath, "ACME");
  const b = await instance(dbPath, "ACME-B");
  expect(loadConfigFile(b.configPath).timeLimits).toBeUndefined();

  expect((await saveTimeLimits(a.configPath, 45))?.status).toBe(200);
  expect(loadConfigFile(a.configPath).timeLimits?.implementationMinutes).toBe(45);
  expect(loadConfigFile(b.configPath).timeLimits).toBeUndefined();

  await b.refresh();
  expect(loadConfigFile(b.configPath).timeLimits?.implementationMinutes).toBe(45);
  expect(readMergeSettings(loadConfigFile(b.configPath)).default.order).toBe("queue");
  expect(loadConfigFile(b.configPath).linearTeam).toBe("ACME-B");
  expect(readFileSync(a.configPath, "utf8")).toBe(BOOTSTRAP);

  expect((await saveTimeLimits(b.configPath, 30))?.status).toBe(200);
  await a.refresh();
  expect(loadConfigFile(a.configPath).timeLimits?.implementationMinutes).toBe(30);
});

test("once the table holds settings, config.toml supplies only what Settings does not own", async () => {
  const a = await instance(shared(), "ACME");
  writeFileSync(a.configPath, `${BOOTSTRAP}\n[queue]\nmax_running_per_owner = 2\n`);
  await updateSetting(sqliteDb(a.db), CONFIG_SETTINGS_KEY, () => '[merge]\norder = "ci-green"\n');
  await a.refresh();
  const config = loadConfigFile(a.configPath);
  expect(readMergeSettings(config).default.order).toBe("ci-green");
  expect(config.queueMaxRunningPerOwner).toBeUndefined();
  expect(config.maxAwakeMs).toBe(5_400_000);
  expect(config.linearTeam).toBe("ACME");
});

test("a command without a running Paws, such as paws doctor, reads the saved settings", async () => {
  const home = tempHome();
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  cleanups.push(useSavedSettings());
  writeFileSync(join(home, "config.toml"), BOOTSTRAP);
  const db = openDatabase(join(home, "paws.db"));
  migrate(db);
  await updateSetting(sqliteDb(db), CONFIG_SETTINGS_KEY, () =>
    [
      '[agents]\nimplementer = "codex"',
      '[agents.defaults.implementer]\nagent = "codex"',
      '[agents.defaults.reviewer]\nagent = "claude"',
    ].join("\n\n"),
  );
  db.close();
  const runtime = loadRuntime({ PAWS_HOME: home });
  expect(runtime.configError).toBe(null);
  expect(resolveAgentProfiles(runtime.file)).toMatchObject({
    implementer: { agent: "codex" },
    reviewer: { agent: "claude" },
  });
  expect(runtime.linearTeam).toBe("ACME");
});

test("a table-like line inside a multiline string is not read as a section", async () => {
  const a = await instance(shared(), "ACME");
  const template = "Summarise the issue.\n[example]\nKeep it short.\n";
  writeFileSync(a.configPath, `${BOOTSTRAP}\n[brief]\ntemplate = """\n${template}"""\n`);
  await updateSetting(
    sqliteDb(a.db),
    CONFIG_SETTINGS_KEY,
    () => "[queue]\nmax_running_per_owner = 2\n",
  );
  await a.refresh();
  const text = readConfigText(a.configPath);
  expect(text).not.toContain("[example]");
  expect(parseBriefTemplates(text).template).toBe(null);

  await updateSetting(
    sqliteDb(a.db),
    CONFIG_SETTINGS_KEY,
    () => `[brief]\ntemplate = """\n${template}"""\n\n[queue]\nmax_running_per_owner = 2\n`,
  );
  await a.refresh();
  expect(parseBriefTemplates(readConfigText(a.configPath)).template).toBe(template);
});

test("triple quotes in a comment or a one-line string do not hide later sections", async () => {
  for (const quote of ['"""', "'''"]) {
    const a = await instance(shared(), "ACME");
    writeFileSync(
      a.configPath,
      `[linear]\nteam = "ACME" # see ${quote}\nnote = "${quote === '"""' ? "'''" : '\\"\\"\\"'}"\n\n[caps]\nmax_awake_ms = 5400000\n\n[merge]\norder = "queue"\n`,
    );
    await updateSetting(sqliteDb(a.db), CONFIG_SETTINGS_KEY, () => '[merge]\norder = "ci-green"\n');
    await a.refresh();
    const text = readConfigText(a.configPath);
    expect(text).not.toContain('order = "queue"');
    expect(text).toContain("max_awake_ms = 5400000");
    expect(text).toContain('order = "ci-green"');
  }
});

test("config.toml sections the saved settings override are named, the rest are not", async () => {
  const a = await instance(shared(), "ACME");
  writeFileSync(a.configPath, `${BOOTSTRAP}\n[merge.projects.abc]\nmain_moved = "ci"\n`);
  expect(overriddenConfigSections(a.configPath)).toEqual([]);
  await updateSetting(sqliteDb(a.db), CONFIG_SETTINGS_KEY, () => '[merge]\norder = "ci-green"\n');
  await a.refresh();
  expect(overriddenConfigSections(a.configPath)).toEqual(["merge", "merge.projects.abc"]);
  expect(describeOverriddenSections(["merge"])).toBe(
    "config.toml [merge] is ignored: the Settings page saved this section to the database, which wins",
  );
});

function gatedStore(initial: string | null) {
  let stored = initial;
  let gate: PromiseWithResolvers<void> | null = null;
  let failure: Error | null = null;
  return {
    store: {
      async read() {
        const value = stored;
        if (failure !== null) throw failure;
        if (gate !== null) await gate.promise;
        return value;
      },
      async update(change: (current: string | null) => string) {
        stored = change(stored);
      },
    },
    hold() {
      gate = Promise.withResolvers<void>();
      return gate;
    },
    fail(error: Error) {
      failure = error;
    },
  };
}

async function gatedInstance(initial: string) {
  const home = tempHome();
  const configPath = join(home, "config.toml");
  writeFileSync(configPath, BOOTSTRAP);
  const gated = gatedStore(initial);
  const settings = await useSettingsStore(configPath, gated.store);
  cleanups.push(() => {
    settings.release();
    rmSync(home, { recursive: true, force: true });
  });
  return { configPath, settings, gated };
}

test("a refresh that read before a local save does not overwrite the save", async () => {
  const { configPath, settings, gated } = await gatedInstance('[merge]\norder = "ci-green"\n');
  const gate = gated.hold();
  const refreshing = settings.refresh();
  expect((await saveTimeLimits(configPath, 45))?.status).toBe(200);
  gate.resolve();
  await refreshing;
  expect(loadConfigFile(configPath).timeLimits?.implementationMinutes).toBe(45);
});

test("a failed refresh keeps the last settings", async () => {
  const { configPath, settings, gated } = await gatedInstance('[merge]\norder = "ci-green"\n');
  gated.fail(new Error("database unavailable"));
  await expect(settings.refresh()).rejects.toThrow("database unavailable");
  expect(readMergeSettings(loadConfigFile(configPath)).default.order).toBe("ci-green");
});
