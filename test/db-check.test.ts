import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE_RETIRED, databaseUrlOf, loadRuntime, startupSettings } from "../src/config";
import { openPawsStore, PgliteInUseError } from "../src/db";
import { tempHome } from "./helpers";
import { copyMigratedPglite } from "./pglite";

describe("PAWS_DATABASE_URL", () => {
  test("a config.toml in the home refuses startup until the variable is set, and is then ignored", () => {
    const home = tempHome();
    const file = join(home, "config.toml");
    writeFileSync(file, `[database]\nurl = "postgres://a:b@file-host/one"\n`);
    expect(() => startupSettings({ PAWS_HOME: home })).toThrow(CONFIG_FILE_RETIRED);
    expect(() => databaseUrlOf({ PAWS_HOME: home })).toThrow(CONFIG_FILE_RETIRED);
    expect(databaseUrlOf({ PAWS_HOME: home, PAWS_DATABASE_URL: "postgresql://env-host/two" })).toBe(
      "postgresql://env-host/two",
    );
    expect(
      loadRuntime({ PAWS_HOME: home, PAWS_DATABASE_URL: "postgresql://env-host/two" }).databaseUrl,
    ).toBe("postgresql://env-host/two");
    expect(existsSync(file)).toBe(true);
  });

  test("with neither the variable nor a config.toml, Paws uses PGlite in the home", () => {
    const home = tempHome();
    expect(startupSettings({ PAWS_HOME: home }).databaseUrl).toBeNull();
    expect(loadRuntime({ PAWS_HOME: home }).databaseUrl).toBeNull();
  });

  test("a URL that is not Postgres is a config error that does not repeat it", () => {
    const fromEnv = loadRuntime({ PAWS_HOME: tempHome(), PAWS_DATABASE_URL: "hunter2" });
    expect(fromEnv.configError).toBe("PAWS_DATABASE_URL is not a URL");
    const mysql = loadRuntime({
      PAWS_HOME: tempHome(),
      PAWS_DATABASE_URL: "mysql://u:hunter2@h/db",
    });
    expect(mysql.configError).not.toContain("hunter2");
  });
});

test("the store Paws starts on refuses a PGlite directory another process holds", async () => {
  const home = tempHome();
  const pgliteDir = join(home, "pglite");
  writeFileSync(`${pgliteDir}.lock`, String(process.ppid));
  await expect(openPawsStore({ url: null, pgliteDir })).rejects.toBeInstanceOf(PgliteInUseError);
  expect(existsSync(pgliteDir)).toBe(false);
});

test("a lock left by a process that exited does not hold PGlite", async () => {
  const home = tempHome();
  const pgliteDir = join(home, "pglite");
  await copyMigratedPglite(pgliteDir);
  writeFileSync(`${pgliteDir}.lock`, String(Bun.spawnSync(["true"]).pid));
  const store = await openPawsStore({ url: null, pgliteDir });
  await store.close();
  expect(existsSync(`${pgliteDir}.lock`)).toBe(false);
}, 30_000);
