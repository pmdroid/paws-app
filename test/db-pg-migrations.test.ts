import { describe, expect, test } from "bun:test";
import { cpSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { getTableName } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { openPawsStore, PG_MIGRATIONS_FOLDER, pgSchema, UnknownDatabaseError } from "../src/db";
import { tempHome } from "./helpers";

const ROOT = new URL("..", import.meta.url).pathname;
const BASELINE = readMigrationFiles({ migrationsFolder: PG_MIGRATIONS_FOLDER })[0]!;
const OLDER = "This database was created by an older Paws. Reset it to start this version.";
const NEWER = "This database was created by a newer Paws. Start that version or reset it.";

function drizzleKit(home: string) {
  cpSync(PG_MIGRATIONS_FOLDER, join(home, "drizzle-pg"), { recursive: true });
  writeFileSync(
    join(home, "drizzle.pg.config.ts"),
    `export default ${JSON.stringify({ dialect: "postgresql", schema: join(ROOT, "src/db/schema-pg/index.ts"), out: "./drizzle-pg" })};\n`,
  );
  const run = Bun.spawnSync(
    [
      process.execPath,
      "--bun",
      join(ROOT, "node_modules/drizzle-kit/bin.cjs"),
      "generate",
      "--config=drizzle.pg.config.ts",
    ],
    { cwd: home, stdout: "pipe", stderr: "pipe" },
  );
  expect(run.exitCode).toBe(0);
  return readdirSync(join(home, "drizzle-pg"))
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

async function withPglite<T>(dir: string, work: (client: PGlite) => Promise<T>): Promise<T> {
  const client = new PGlite(dir, { extensions: { citext } });
  try {
    return await work(client);
  } finally {
    await client.close();
  }
}

async function unknownDatabase(createdAt: number): Promise<string> {
  const home = tempHome();
  await withPglite(join(home, "pglite"), (client) =>
    client.exec(`
      CREATE SCHEMA drizzle;
      CREATE TABLE drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint);
      INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('unknown', ${createdAt});
    `),
  );
  return home;
}

async function contents(home: string) {
  return withPglite(join(home, "pglite"), async (client) => ({
    migrations: (await client.query("SELECT hash, created_at FROM drizzle.__drizzle_migrations"))
      .rows,
    tables: (
      await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'",
      )
    ).rows[0]!.n,
  }));
}

async function spawnPaws(home: string, args: string[]) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    PAWS_HOME: home,
    PAWS_PORT: "0",
    PAWS_HOST: "127.0.0.1",
  };
  for (const key of Object.keys(env))
    if (
      key.startsWith("LINEAR_") ||
      key === "PAWS_EXECUTION" ||
      key === "PAWS_PUBLIC_URL" ||
      key === "PAWS_DATABASE_URL"
    )
      delete env[key];
  const proc = Bun.spawn(["bun", "src/index.ts", ...args], {
    cwd: ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { stderr, code };
}

describe("Postgres drizzle-kit migrations", () => {
  test("a fresh database migrates to the single baseline with every table", async () => {
    const pgliteDir = join(tempHome(), "pglite");
    const opened = await openPawsStore({ url: null, pgliteDir });
    await opened.close();
    await withPglite(pgliteDir, async (client) => {
      const applied = await client.query("SELECT hash FROM drizzle.__drizzle_migrations");
      expect(applied.rows).toEqual([{ hash: BASELINE.hash }]);
      const tables = await client.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
      );
      const expected = Object.values(pgSchema).map((table) => getTableName(table));
      expect(tables.rows.map((row) => row.table_name).sort()).toEqual(expected.sort());
      const triggers = await client.query<{ tgname: string }>(
        "SELECT tgname FROM pg_trigger WHERE tgrelid = 'work_item'::regclass AND NOT tgisinternal ORDER BY tgname",
      );
      expect(triggers.rows.map((row) => row.tgname)).toEqual([
        "runner_setup_hold_ends",
        "runner_setup_resume_ends",
      ]);
      const sequence = await client.query("SELECT nextval('job_activation_seq') AS n");
      expect(sequence.rows).toHaveLength(1);
      const equal = await client.query("SELECT 'Org/Repo'::citext = 'org/repo' AS equal");
      expect(equal.rows).toEqual([{ equal: true }]);
    });
  }, 30_000);

  test("the Postgres schema has no change without a migration", () => {
    expect(drizzleKit(tempHome())).toEqual(["0000_baseline.sql"]);
  });

  for (const [name, createdAt, message] of [
    ["older", BASELINE.folderMillis - 1, OLDER],
    ["newer", BASELINE.folderMillis + 1, NEWER],
  ] as const)
    test(`a database from a ${name} Paws is refused and left unchanged`, async () => {
      const home = await unknownDatabase(createdAt);
      const before = await contents(home);
      expect(before.tables).toBe(0);

      const opening = openPawsStore({ url: null, pgliteDir: join(home, "pglite") });
      await expect(opening).rejects.toBeInstanceOf(UnknownDatabaseError);
      await expect(opening).rejects.toThrow(message);

      const started = await spawnPaws(home, []);
      expect(started.code).toBe(1);
      expect(started.stderr.trim()).toBe(message);

      const checked = await spawnPaws(home, ["db", "check"]);
      expect(checked.code).toBe(1);
      expect(checked.stderr).toContain(message);

      expect(await contents(home)).toEqual(before);
    }, 60_000);
});
