import { afterEach, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  openPawsStore,
  readSetting,
  readSettingSteps,
  updateSetting,
  updateSettingSteps,
  type Db,
} from "../src/db";
import { withSavedStore } from "../src/doctor";
import { snapshotImplementationSkills } from "../src/acp";
import {
  handleMergeSettingsRequest,
  handleSkillSettingsRequest,
  handleTimeLimitSettingsRequest,
} from "../src/settings";
import { fakeSkillResolver } from "../src/skills";
import { tempHome } from "./helpers";
import { copyMigratedPglite, pgliteServer, tempStore } from "./pglite";

const BOOTSTRAP = `[linear]
team = "ACME"

[caps]
max_awake_ms = 5400000

[merge]
order = "queue"
`;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function instance(store: Db, team: string) {
  const home = tempHome();
  const configPath = join(home, "config.toml");
  writeFileSync(configPath, BOOTSTRAP.replace("ACME", team));
  const settings = await useSettingsStore(configPath, {
    read: () => store.run((q) => readSettingSteps(q, CONFIG_SETTINGS_KEY)),
    update: (change) =>
      store.transaction((q) => updateSettingSteps(q, CONFIG_SETTINGS_KEY, change)),
  });
  cleanups.push(() => {
    settings.release();
    rmSync(home, { recursive: true, force: true });
  });
  return { db: store, configPath, refresh: settings.refresh };
}

async function shared(): Promise<Db> {
  const { db, close } = await tempStore();
  cleanups.push(close);
  return db;
}

function saveTimeLimits(configPath: string, implementationMinutes: number) {
  return handleTimeLimitSettingsRequest(
    new Request("http://127.0.0.1:8787/api/settings/time-limits", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-paws-csrf": "csrf" },
      body: JSON.stringify({
        default: { implementationMinutes, fixesMinutes: 0, closeoutMinutes: 0 },
      }),
    }),
    { configPath, csrfToken: "csrf", role: "admin", audit: async () => {} },
  );
}

test("an empty setting table reads config.toml as the bootstrap", async () => {
  const a = await instance(await shared(), "ACME");
  expect(await readSetting(a.db, CONFIG_SETTINGS_KEY)).toBe(null);
  expect(readMergeSettings(loadConfigFile(a.configPath)).default.order).toBe("queue");
  expect(loadConfigFile(a.configPath).linearTeam).toBe("ACME");
});

test("a setting saved on instance A is read by instance B after its next refresh", async () => {
  const db = await shared();
  const a = await instance(db, "ACME");
  const b = await instance(db, "ACME-B");
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
  const a = await instance(await shared(), "ACME");
  writeFileSync(a.configPath, `${BOOTSTRAP}\n[queue]\nmax_running_per_owner = 2\n`);
  await updateSetting(a.db, CONFIG_SETTINGS_KEY, () => '[merge]\norder = "ci-green"\n');
  await a.refresh();
  const config = loadConfigFile(a.configPath);
  expect(readMergeSettings(config).default.order).toBe("ci-green");
  expect(config.queueMaxRunningPerOwner).toBeUndefined();
  expect(config.maxAwakeMs).toBe(5_400_000);
  expect(config.linearTeam).toBe("ACME");
});

const SAVED_AGENTS = [
  '[agents]\nimplementer = "codex"',
  '[agents.defaults.implementer]\nagent = "codex"',
  '[agents.defaults.reviewer]\nagent = "claude"',
].join("\n\n");

async function savedSettingsHome(): Promise<string> {
  const home = tempHome();
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, "config.toml"), BOOTSTRAP);
  await copyMigratedPglite(join(home, "pglite"));
  const database = await openPawsStore({ url: null, pgliteDir: join(home, "pglite") });
  await updateSetting(database.store, CONFIG_SETTINGS_KEY, () => SAVED_AGENTS);
  await database.close();
  return home;
}

test("a command without a running Paws, such as paws doctor, reads the saved settings", async () => {
  const home = await savedSettingsHome();
  const saved = await withSavedStore({ PAWS_HOME: home }, async ({ held }) => ({
    held,
    runtime: loadRuntime({ PAWS_HOME: home }),
  }));
  expect(saved.held).toBe(false);
  expect(saved.runtime.configError).toBe(null);
  expect(resolveAgentProfiles(saved.runtime.file)).toMatchObject({
    implementer: { agent: "codex" },
    reviewer: { agent: "claude" },
  });
  expect(saved.runtime.linearTeam).toBe("ACME");
  expect(resolveAgentProfiles(loadRuntime({ PAWS_HOME: home }).file).implementer.agent).toBe(
    "claude",
  );
}, 30_000);

test("while Paws holds PGlite a command uses config.toml and says so", async () => {
  const home = await savedSettingsHome();
  writeFileSync(join(home, "pglite.lock"), String(process.ppid));
  const saved = await withSavedStore({ PAWS_HOME: home }, async ({ store, held }) => ({
    store,
    held,
    runtime: loadRuntime({ PAWS_HOME: home }),
  }));
  expect(saved).toMatchObject({ store: null, held: true });
  expect(resolveAgentProfiles(saved.runtime.file).implementer.agent).toBe("claude");
}, 30_000);

test("with [database] url a command reads the saved settings from that Postgres", async () => {
  const server = await pgliteServer();
  const home = tempHome();
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  try {
    writeFileSync(join(home, "config.toml"), BOOTSTRAP);
    await updateSetting(server.store, CONFIG_SETTINGS_KEY, () => SAVED_AGENTS);
    const env = { PAWS_HOME: home, PAWS_DATABASE_URL: server.url };
    const saved = await withSavedStore(env, async ({ held }) => ({
      held,
      runtime: loadRuntime(env),
    }));
    expect(saved.held).toBe(false);
    expect(resolveAgentProfiles(saved.runtime.file).implementer.agent).toBe("codex");
    expect(existsSync(join(home, "pglite"))).toBe(false);
  } finally {
    await server.close();
  }
}, 30_000);

test("a table-like line inside a multiline string is not read as a section", async () => {
  const a = await instance(await shared(), "ACME");
  const template = "Summarise the issue.\n[example]\nKeep it short.\n";
  writeFileSync(a.configPath, `${BOOTSTRAP}\n[brief]\ntemplate = """\n${template}"""\n`);
  await updateSetting(a.db, CONFIG_SETTINGS_KEY, () => "[queue]\nmax_running_per_owner = 2\n");
  await a.refresh();
  const text = readConfigText(a.configPath);
  expect(text).not.toContain("[example]");
  expect(parseBriefTemplates(text).template).toBe(null);

  await updateSetting(
    a.db,
    CONFIG_SETTINGS_KEY,
    () => `[brief]\ntemplate = """\n${template}"""\n\n[queue]\nmax_running_per_owner = 2\n`,
  );
  await a.refresh();
  expect(parseBriefTemplates(readConfigText(a.configPath)).template).toBe(template);
});

test("triple quotes in a comment or a one-line string do not hide later sections", async () => {
  for (const quote of ['"""', "'''"]) {
    const a = await instance(await shared(), "ACME");
    writeFileSync(
      a.configPath,
      `[linear]\nteam = "ACME" # see ${quote}\nnote = "${quote === '"""' ? "'''" : '\\"\\"\\"'}"\n\n[caps]\nmax_awake_ms = 5400000\n\n[merge]\norder = "queue"\n`,
    );
    await updateSetting(a.db, CONFIG_SETTINGS_KEY, () => '[merge]\norder = "ci-green"\n');
    await a.refresh();
    const text = readConfigText(a.configPath);
    expect(text).not.toContain('order = "queue"');
    expect(text).toContain("max_awake_ms = 5400000");
    expect(text).toContain('order = "ci-green"');
  }
});

test("config.toml sections the saved settings override are named, the rest are not", async () => {
  const a = await instance(await shared(), "ACME");
  writeFileSync(a.configPath, `${BOOTSTRAP}\n[merge.projects.abc]\nmain_moved = "ci"\n`);
  expect(overriddenConfigSections(a.configPath)).toEqual([]);
  await updateSetting(a.db, CONFIG_SETTINGS_KEY, () => '[merge]\norder = "ci-green"\n');
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

test("project skill roots save to the database and the next turn's skill loading uses them", async () => {
  const a = await instance(await shared(), "ACME");
  const home = join(a.configPath, "..");
  const skills = (name: string) => {
    const root = join(home, name);
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, "SKILL.md"), `# ${name}\n`);
    return root;
  };
  const fileRoot = skills("from-file");
  const savedRoot = skills("from-settings");
  const worktree = join(home, "worktree");
  mkdirSync(worktree);
  appendFileSync(a.configPath, `\n[skills.projects."acme/app"]\nroot = "${fileRoot}"\n`);
  const audit: string[] = [];
  const request = (role: string, init?: RequestInit) =>
    handleSkillSettingsRequest(new Request("http://127.0.0.1:8787/api/settings/skills", init), {
      store: a.db,
      configPath: a.configPath,
      root: join(home, "skills"),
      resolver: fakeSkillResolver(),
      csrfToken: "csrf",
      role,
      audit: async (_action, subject) => {
        audit.push(subject);
      },
    });
  const put = (role: string, projectRoots: unknown) =>
    request(role, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-paws-csrf": "csrf" },
      body: JSON.stringify({ projectRoots }),
    });
  const roots = async () =>
    ((await (await request("admin"))!.json()) as { projectRoots: unknown }).projectRoots;
  const loaded = async () =>
    new TextDecoder().decode(
      await snapshotImplementationSkills({ pawsRoot: home, worktree, repository: "acme/app" }),
    );

  expect(await roots()).toEqual({ projects: { "acme/app": { root: fileRoot } } });
  expect(await loaded()).toContain("from-file");

  expect((await put("member", { projects: { "acme/app": { root: savedRoot } } }))!.status).toBe(
    403,
  );
  for (const root of [
    "relative/skills",
    join(home, "missing"),
    join(fileRoot, "from-file", "SKILL.md"),
  ]) {
    const refused = await put("admin", { projects: { "acme/app": { root } } });
    expect(refused!.status).toBe(400);
    expect(((await refused!.json()) as { error: string }).error).toContain("acme/app root");
  }
  expect((await put("admin", { projects: { "not a repo": { root: savedRoot } } }))!.status).toBe(
    400,
  );
  expect(await readSetting(a.db, CONFIG_SETTINGS_KEY)).toBe(null);

  expect((await put("admin", { projects: { "Acme/App": { root: savedRoot } } }))!.status).toBe(200);
  expect(audit).toEqual([`Set project skill roots: acme/app ${savedRoot}`]);
  expect(await readSetting(a.db, CONFIG_SETTINGS_KEY)).toContain(savedRoot);
  expect(await roots()).toEqual({ projects: { "acme/app": { root: savedRoot } } });
  expect(await loaded()).toContain("from-settings");

  appendFileSync(a.configPath, `\n[skills.projects."acme/other"]\nroot = "${fileRoot}"\n`);
  expect(await roots()).toEqual({ projects: { "acme/app": { root: savedRoot } } });
  expect(overriddenConfigSections(a.configPath)).toEqual([
    "merge",
    'skills.projects."acme/app"',
    'skills.projects."acme/other"',
  ]);
  expect(await loaded()).toContain("from-settings");
});

test("merging repository settings and project lanes round-trip in Postgres without restarting", async () => {
  const a = await instance(await shared(), "ACME");
  const initial = `${BOOTSTRAP}
[merge.repositories."acme/web"]
packages = ["old/*"]
review_apps = ["old-review"]
suggested_findings = "off"
high_risk_paths = ["infra/**"]
[merge.projects.project]
lane = "project"
`;
  writeFileSync(a.configPath, initial);
  const options = { configPath: a.configPath, csrfToken: "csrf", role: "admin" };
  const get = async () =>
    (await handleMergeSettingsRequest(
      new Request("http://localhost/api/settings/merging"),
      options,
    ))!.json();
  expect(await get()).toMatchObject({
    repositories: { "acme/web": { packages: ["old/*"], suggestedFindings: false } },
    projects: { project: { lane: "project" } },
  });
  const body = {
    default: { order: "queue", mainMoved: "ci" },
    repositories: {
      "acme/web": {
        packages: ["apps/*"],
        reviewApps: ["acme-review"],
        suggestedFindings: true,
      },
    },
    projects: { project: { lane: "repository" } },
  };
  const put = (value: unknown) =>
    handleMergeSettingsRequest(
      new Request("http://localhost/api/settings/merging", {
        method: "PUT",
        headers: { "content-type": "application/json", "x-paws-csrf": "csrf" },
        body: JSON.stringify(value),
      }),
      options,
    );
  const response = await put(body);
  expect(response?.status).toBe(200);
  expect(await response!.json()).toMatchObject(body);
  expect(await readSetting(a.db, CONFIG_SETTINGS_KEY)).toContain('review_apps = ["acme-review"]');
  expect(readFileSync(a.configPath, "utf8")).toBe(initial);
  writeFileSync(a.configPath, initial.replace("old/*", "changed/*"));
  expect(await get()).toMatchObject(body);
  expect(readMergeSettings(loadConfigFile(a.configPath))).toMatchObject({
    repositories: {
      "acme/web": {
        ...body.repositories["acme/web"],
        suggestedFindings: "next_turn",
        highRiskPaths: ["infra/**"],
      },
    },
    projectLanes: { project: "repository" },
  });
  expect((await put({ default: body.default }))?.status).toBe(200);
  expect(await get()).toMatchObject(body);
  const disabled = { ...body, repositories: { "acme/web": { suggestedFindings: false } } };
  const disabledResponse = await put(disabled);
  expect(disabledResponse?.status).toBe(200);
  expect(await disabledResponse!.json()).toMatchObject(disabled);
  expect(await get()).toMatchObject(disabled);
  expect(
    readMergeSettings(loadConfigFile(a.configPath)).repositories["acme/web"]?.suggestedFindings,
  ).toBe("off");
  expect((await put({ default: body.default, repositories: {}, projects: {} }))?.status).toBe(200);
  expect(await get()).toMatchObject({
    repositories: { "acme/web": { packages: [] } },
    projects: {},
  });
});
