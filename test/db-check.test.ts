import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { migrate as pgliteMigrate } from "drizzle-orm/pglite/migrator";
import { databaseUrlOf, loadRuntime } from "../src/config";
import {
  migrationTags,
  openPawsStore,
  PG_MIGRATIONS_FOLDER,
  PgliteInUseError,
  type PostgresConnection,
} from "../src/db";
import { dbCheckMain } from "../src/index";
import { tempHome } from "./helpers";
import { copyMigratedPglite, pgliteDb } from "./pglite";

const URL_WITH_PASSWORD = "postgres://paws:s3cr%40t@127.0.0.1:1/paws_db";

async function pglite(): Promise<PostgresConnection> {
  const db = await pgliteDb({ migrated: false });
  return {
    db,
    migrate: () => pgliteMigrate(db, { migrationsFolder: PG_MIGRATIONS_FOLDER }),
    close: () => db.$client.close(),
  };
}

async function check(env: Record<string, string>, connect?: (url: string) => PostgresConnection) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await dbCheckMain(
    env,
    connect,
    (line) => out.push(line),
    (line) => err.push(line),
  );
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("PAWS_DATABASE_URL", () => {
  test("a config.toml [database] url is not read and the variable sets the URL", () => {
    const home = tempHome();
    writeFileSync(join(home, "config.toml"), `[database]\nurl = "postgres://a:b@file-host/one"\n`);
    expect(databaseUrlOf({ PAWS_HOME: home })).toBeNull();
    expect(loadRuntime({ PAWS_HOME: home }).databaseUrl).toBeNull();
    expect(
      loadRuntime({ PAWS_HOME: home, PAWS_DATABASE_URL: "postgresql://env-host/two" }).databaseUrl,
    ).toBe("postgresql://env-host/two");
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

describe("paws db check", () => {
  test("against PGlite it applies migrations and prints ok", async () => {
    const connection = await pglite();
    const ok = await check(
      { PAWS_HOME: tempHome(), PAWS_DATABASE_URL: URL_WITH_PASSWORD },
      () => connection,
    );
    expect(ok.err).toBe("");
    expect(ok.code).toBe(0);
    expect(ok.out).toContain(`· ${migrationTags(PG_MIGRATIONS_FOLDER).length} of `);
    expect(ok.out).toMatch(
      /^ok · Postgres 127\.0\.0\.1:1\/paws_db · server \d+\.\d+ · (\d+) of \1 migrations applied$/,
    );
  });

  test("a bad URL exits non-zero without the password", async () => {
    const result = await check({ PAWS_HOME: tempHome(), PAWS_DATABASE_URL: URL_WITH_PASSWORD });
    expect(result.code).toBe(1);
    expect(result.err).toStartWith("paws db check failed on Postgres 127.0.0.1:1/paws_db: ");
    expect(result.err).not.toContain("s3cr");
    expect(result.out).toBe("");
  });

  test("a failure message that repeats the URL is redacted", async () => {
    const result = await check(
      { PAWS_HOME: tempHome(), PAWS_DATABASE_URL: URL_WITH_PASSWORD },
      () => {
        throw new Error(`cannot reach ${URL_WITH_PASSWORD} with s3cr@t`);
      },
    );
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      "paws db check failed on Postgres 127.0.0.1:1/paws_db: cannot reach *** with ***",
    );
  });

  test("without a URL and before the first start there is no PGlite database yet", async () => {
    const home = tempHome();
    const result = await check({ PAWS_HOME: home });
    expect(result.code).toBe(0);
    expect(result.out).toBe(
      `ok · PGlite ${join(home, "pglite")} · no database yet; migrations apply at start`,
    );
    expect(existsSync(join(home, "pglite"))).toBe(false);
  });

  test("without a URL it checks the idle PGlite directory and releases it", async () => {
    const home = tempHome();
    await copyMigratedPglite(join(home, "pglite"));
    const result = await check({ PAWS_HOME: home });
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(result.out).toMatch(
      /^ok · PGlite .*pglite · server \d+\.\d+ · (\d+) of \1 migrations applied$/,
    );
    expect(existsSync(join(home, "pglite.lock"))).toBe(false);
  }, 30_000);

  test("without a URL while Paws holds PGlite it says Paws is running", async () => {
    const home = tempHome();
    await copyMigratedPglite(join(home, "pglite"));
    writeFileSync(join(home, "pglite.lock"), String(process.ppid));
    const result = await check({ PAWS_HOME: home });
    expect(result.code).toBe(1);
    expect(result.out).toBe("");
    expect(result.err).toBe(
      "paws db check: Paws is running; stop it or set PAWS_DATABASE_URL to check",
    );
    expect(readFileSync(join(home, "pglite.lock"), "utf8")).toBe(String(process.ppid));
  });

  test("a lock left by a process that exited does not hold PGlite", async () => {
    const home = tempHome();
    await copyMigratedPglite(join(home, "pglite"));
    writeFileSync(join(home, "pglite.lock"), String(Bun.spawnSync(["true"]).pid));
    const result = await check({ PAWS_HOME: home });
    expect(result.code).toBe(0);
    expect(existsSync(join(home, "pglite.lock"))).toBe(false);
  }, 30_000);
});

test("the store Paws starts on refuses a PGlite directory another process holds", async () => {
  const home = tempHome();
  const pgliteDir = join(home, "pglite");
  writeFileSync(`${pgliteDir}.lock`, String(process.ppid));
  await expect(openPawsStore({ url: null, pgliteDir })).rejects.toBeInstanceOf(PgliteInUseError);
  expect(existsSync(pgliteDir)).toBe(false);
});
