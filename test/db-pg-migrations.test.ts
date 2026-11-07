import { describe, expect, test } from "bun:test";
import { cpSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getTableName } from "drizzle-orm";
import { migrate } from "drizzle-orm/pglite/migrator";
import { PG_MIGRATIONS_FOLDER, pgSchema, rawSchema } from "../src/db";
import { tempHome } from "./helpers";
import { pgliteDb } from "./pglite";

const ROOT = new URL("..", import.meta.url).pathname;

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

describe("Postgres drizzle-kit migrations", () => {
  test("the migrations apply to a fresh PGlite database, once each, with every table", async () => {
    const db = await pgliteDb();
    try {
      await migrate(db, { migrationsFolder: PG_MIGRATIONS_FOLDER });
      const applied = await db.$client.query("SELECT hash FROM drizzle.__drizzle_migrations");
      const journal = JSON.parse(
        readFileSync(join(PG_MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"),
      ) as { entries: unknown[] };
      expect(applied.rows).toHaveLength(journal.entries.length);
      const tables = await db.$client.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
      );
      const expected = Object.values(pgSchema).map((table) => getTableName(table));
      expect(tables.rows.map((row) => row.table_name).sort()).toEqual(expected.sort());
    } finally {
      await db.$client.close();
    }
  });

  test("a NOCASE column is citext, so it compares case-insensitively", async () => {
    const db = await pgliteDb();
    try {
      const columns = await db.$client.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.columns WHERE column_name = 'repository' AND udt_name = 'citext'",
      );
      expect(columns.rows.map((row) => row.table_name).sort()).toEqual(
        Object.keys(rawSchema.collations).sort(),
      );
      const equal = await db.$client.query<{ equal: boolean }>(
        "SELECT 'Org/Repo'::citext = 'org/repo' AS equal",
      );
      expect(equal.rows).toEqual([{ equal: true }]);
    } finally {
      await db.$client.close();
    }
  });

  test("journal starts with 0000_baseline", () => {
    const journal = JSON.parse(
      readFileSync(join(PG_MIGRATIONS_FOLDER, "meta/_journal.json"), "utf8"),
    ) as { dialect: string; entries: { tag: string }[] };
    expect(journal.dialect).toBe("postgresql");
    expect(journal.entries[0]?.tag).toBe("0000_baseline");
  });

  test("the Postgres schema has no change without a migration", () => {
    expect(drizzleKit(tempHome())).toEqual(
      readdirSync(PG_MIGRATIONS_FOLDER)
        .filter((name) => name.endsWith(".sql"))
        .sort(),
    );
  });
});
