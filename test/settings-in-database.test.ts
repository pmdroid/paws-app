import { afterEach, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfigFile, readMergeSettings, useSettingsStore } from "../src/config";
import { CONFIG_SETTINGS_KEY, migrate, openDatabase, readSetting, updateSetting } from "../src/db";
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

function instance(dbPath: string, team: string) {
  const home = tempHome();
  const configPath = join(home, "config.toml");
  writeFileSync(configPath, BOOTSTRAP.replace("ACME", team));
  const db = openDatabase(dbPath);
  migrate(db);
  const release = useSettingsStore(configPath, {
    read: () => readSetting(db, CONFIG_SETTINGS_KEY),
    update: (change) => updateSetting(db, CONFIG_SETTINGS_KEY, change),
  });
  cleanups.push(() => {
    release();
    db.close();
    rmSync(home, { recursive: true, force: true });
  });
  return { db, configPath };
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
    { configPath, csrfToken: "csrf", role: "admin", audit: () => {} },
  );
}

test("an empty setting table reads config.toml as the bootstrap", () => {
  const a = instance(shared(), "ACME");
  expect(readSetting(a.db, CONFIG_SETTINGS_KEY)).toBe(null);
  expect(readMergeSettings(loadConfigFile(a.configPath)).default.order).toBe("queue");
  expect(loadConfigFile(a.configPath).linearTeam).toBe("ACME");
});

test("a setting saved on instance A is read by instance B on its next use", async () => {
  const dbPath = shared();
  const a = instance(dbPath, "ACME");
  const b = instance(dbPath, "ACME-B");
  expect(loadConfigFile(b.configPath).timeLimits).toBeUndefined();

  expect((await saveTimeLimits(a.configPath, 45))?.status).toBe(200);

  expect(loadConfigFile(b.configPath).timeLimits?.implementationMinutes).toBe(45);
  expect(readMergeSettings(loadConfigFile(b.configPath)).default.order).toBe("queue");
  expect(loadConfigFile(b.configPath).linearTeam).toBe("ACME-B");
  expect(readFileSync(a.configPath, "utf8")).toBe(BOOTSTRAP);

  expect((await saveTimeLimits(b.configPath, 30))?.status).toBe(200);
  expect(loadConfigFile(a.configPath).timeLimits?.implementationMinutes).toBe(30);
});

test("once the table holds settings, config.toml supplies only what Settings does not own", () => {
  const a = instance(shared(), "ACME");
  writeFileSync(a.configPath, `${BOOTSTRAP}\n[queue]\nmax_running_per_owner = 2\n`);
  updateSetting(a.db, CONFIG_SETTINGS_KEY, () => '[merge]\norder = "ci-green"\n');
  const config = loadConfigFile(a.configPath);
  expect(readMergeSettings(config).default.order).toBe("ci-green");
  expect(config.queueMaxRunningPerOwner).toBeUndefined();
  expect(config.maxAwakeMs).toBe(5_400_000);
  expect(config.linearTeam).toBe("ACME");
});
