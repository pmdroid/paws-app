import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { migrate as pgliteMigrate } from "drizzle-orm/pglite/migrator";
import { loadRuntime } from "../src/config";
import {
  migrate,
  migrationTags,
  openDatabase,
  PG_MIGRATIONS_FOLDER,
  type PostgresConnection,
} from "../src/db";
import { dbCheckMain } from "../src/index";
import { tempHome } from "./helpers";
import { pgliteDb } from "./pglite";

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

describe("[database] url", () => {
  test("config.toml sets it and PAWS_DATABASE_URL wins", () => {
    const home = tempHome();
    writeFileSync(join(home, "config.toml"), `[database]\nurl = "postgres://a:b@file-host/one"\n`);
    expect(loadRuntime({ PAWS_HOME: home }).databaseUrl).toBe("postgres://a:b@file-host/one");
    expect(
      loadRuntime({ PAWS_HOME: home, PAWS_DATABASE_URL: "postgresql://env-host/two" }).databaseUrl,
    ).toBe("postgresql://env-host/two");
    expect(loadRuntime({ PAWS_HOME: tempHome() }).databaseUrl).toBeNull();
  });

  test("a URL that is not Postgres is a config error that does not repeat it", () => {
    const home = tempHome();
    writeFileSync(join(home, "config.toml"), `[database]\nurl = "mysql://u:hunter2@h/db"\n`);
    const fromFile = loadRuntime({ PAWS_HOME: home }).configError;
    expect(fromFile).toBe(
      "config.toml line 2: database.url must start with postgres:// or postgresql://",
    );
    const fromEnv = loadRuntime({ PAWS_HOME: tempHome(), PAWS_DATABASE_URL: "hunter2" });
    expect(fromEnv.configError).toBe("PAWS_DATABASE_URL is not a URL");
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

  test("without a URL it says SQLite is in use and checks its migrations", async () => {
    const home = tempHome();
    const empty = await check({ PAWS_HOME: home });
    expect(empty.code).toBe(0);
    expect(empty.out).toContain("SQLite is in use");
    expect(empty.out).toContain("no database yet");
    const db = openDatabase(join(home, "paws.db"));
    migrate(db);
    db.close();
    const migrated = await check({ PAWS_HOME: home });
    expect(migrated.code).toBe(0);
    expect(migrated.out).toMatch(/ok · SQLite .*paws\.db · (\d+) of \1 migrations applied$/);
  });

  test("a SQLite database whose migration differs from this Paws fails", async () => {
    const home = tempHome();
    const db = openDatabase(join(home, "paws.db"));
    migrate(db);
    db.run(
      "UPDATE __drizzle_migrations SET hash = 'other' WHERE created_at = (SELECT min(created_at) FROM __drizzle_migrations)",
    );
    db.close();
    const result = await check({ PAWS_HOME: home });
    expect(result.code).toBe(1);
    expect(result.err).toContain(
      "migration 0000_baseline differs from the one the database applied",
    );
  });
});
