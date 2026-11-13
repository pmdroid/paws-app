import { describe, expect, test } from "bun:test";
import { cpSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS_FOLDER, migrate, openDatabase } from "../src/db";
import { migrateDryRun } from "../scripts/migrate-dry-run";
import { tempHome } from "./helpers";

const ROOT = new URL("..", import.meta.url).pathname;
const SHIPPED = readdirSync(MIGRATIONS_FOLDER)
  .filter((name) => name.endsWith(".sql"))
  .sort();

function drizzleKit(home: string, ...args: string[]) {
  cpSync(MIGRATIONS_FOLDER, join(home, "drizzle"), { recursive: true });
  writeFileSync(
    join(home, "drizzle.config.ts"),
    `export default ${JSON.stringify({ dialect: "sqlite", schema: join(ROOT, "src/db/schema/index.ts"), out: "./drizzle" })};\n`,
  );
  const run = Bun.spawnSync(
    [
      process.execPath,
      "--bun",
      join(ROOT, "node_modules/drizzle-kit/bin.cjs"),
      "generate",
      ...args,
    ],
    { cwd: home, stdout: "pipe", stderr: "pipe" },
  );
  expect(run.exitCode).toBe(0);
  return readdirSync(join(home, "drizzle"))
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

describe("drizzle-kit migrations", () => {
  test("record each shipped migration on a new database, once", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    migrate(db);
    expect(db.query("SELECT hash FROM __drizzle_migrations").all()).toHaveLength(SHIPPED.length);
    expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 'schema_migration'").get()).toBe(
      null,
    );
  });

  test("journal entries are in the order drizzle-kit applies them", () => {
    const journal = JSON.parse(
      readFileSync(join(MIGRATIONS_FOLDER, "meta/_journal.json"), "utf8"),
    ) as { entries: { idx: number; when: number; tag: string }[] };
    expect(journal.entries[0]?.tag).toBe("0000_baseline");
    journal.entries.forEach((entry, index) => {
      expect(entry.idx).toBe(index);
      if (index > 0) expect(entry.when).toBeGreaterThan(journal.entries[index - 1]!.when);
    });
  });

  test("the schema has no change without a migration", () => {
    expect(drizzleKit(tempHome()).sort()).toEqual(SHIPPED);
  });

  test("a migration drizzle-kit generates after the shipped ones applies on a fresh database", () => {
    const home = tempHome();
    const out = join(home, "drizzle");
    const probe = `${String(SHIPPED.length).padStart(4, "0")}_probe.sql`;
    expect(drizzleKit(home, "--custom", "--name=probe").sort()).toEqual([...SHIPPED, probe]);
    writeFileSync(join(out, probe), "ALTER TABLE work_item ADD COLUMN probe TEXT;\n");

    const db = openDatabase(":memory:");
    migrate(db, { migrationsFolder: out });
    expect(db.query("SELECT hash FROM __drizzle_migrations").all()).toHaveLength(
      SHIPPED.length + 1,
    );
    expect(
      db.query("SELECT name FROM pragma_table_info('work_item') WHERE name = 'probe'").get(),
    ).toEqual({ name: "probe" });
  });
});

describe("migrate:dry-run", () => {
  test("reports nothing to apply on a migrated copy", () => {
    const home = tempHome();
    const current = join(home, "current.db");
    const db = openDatabase(current);
    migrate(db);
    db.close();
    expect(migrateDryRun(current)).toEqual({ applied: [] });
  });
});
