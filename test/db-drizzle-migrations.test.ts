import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  legacyMigrate,
  MIGRATIONS_FOLDER,
  migrate,
  openDatabase,
  setAsideLegacyDatabase,
} from "../src/db";
import { setJournalSink } from "../src/journal";
import { migrateDryRun } from "../scripts/migrate-dry-run";
import { tempHome } from "./helpers";

const ROOT = new URL("..", import.meta.url).pathname;
const NOW = new Date("2026-11-07T03:04:05.678Z");

function legacyDatabase(home: string) {
  const path = join(home, "paws.db");
  const db = openDatabase(path);
  legacyMigrate(db);
  db.run("PRAGMA wal_autocheckpoint = 0");
  db.run("INSERT INTO sync_cursor (name, cursor_ms) VALUES ('legacy', 1)");
  expect(existsSync(`${path}-shm`)).toBe(true);
  return { path, db, file: readFileSync(path), wal: readFileSync(`${path}-wal`) };
}

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
  test("record 0000_baseline on a new database, once", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    migrate(db);
    expect(db.query("SELECT hash FROM __drizzle_migrations").all()).toHaveLength(1);
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
    expect(drizzleKit(tempHome())).toEqual(
      readdirSync(MIGRATIONS_FOLDER).filter((name) => name.endsWith(".sql")),
    );
  });

  test("a migration drizzle-kit generates after the baseline applies on a fresh database", () => {
    const home = tempHome();
    const out = join(home, "drizzle");
    expect(drizzleKit(home, "--custom", "--name=probe")).toEqual([
      "0000_baseline.sql",
      "0001_probe.sql",
    ]);
    writeFileSync(join(out, "0001_probe.sql"), "ALTER TABLE work_item ADD COLUMN probe TEXT;\n");

    const db = openDatabase(":memory:");
    migrate(db, { migrationsFolder: out });
    expect(db.query("SELECT hash FROM __drizzle_migrations").all()).toHaveLength(2);
    expect(
      db.query("SELECT name FROM pragma_table_info('work_item') WHERE name = 'probe'").get(),
    ).toEqual({ name: "probe" });
  });
});

describe("a database from the legacy migrations", () => {
  test("is renamed with its WAL and SHM files, untouched, and Paws starts fresh", () => {
    const home = tempHome();
    const legacy = legacyDatabase(home);
    const { path } = legacy;
    const lines: string[] = [];
    const restore = setJournalSink((line) => lines.push(line));
    let moved: string | null;
    try {
      moved = setAsideLegacyDatabase(path, NOW);
    } finally {
      restore();
    }
    legacy.db.close();
    const target = join(home, "paws.db.pre-drizzle-20261107T030405Z");
    expect(moved).toBe(target);
    expect(lines).toEqual([
      `database reset: the database from before drizzle-kit migrations was renamed to ${target}; Paws starts on a fresh database`,
    ]);
    expect(readdirSync(home).sort()).toEqual([
      "paws.db.pre-drizzle-20261107T030405Z",
      "paws.db.pre-drizzle-20261107T030405Z-shm",
      "paws.db.pre-drizzle-20261107T030405Z-wal",
    ]);
    expect(readFileSync(target)).toEqual(legacy.file);
    expect(readFileSync(`${target}-wal`)).toEqual(legacy.wal);

    const fresh = openDatabase(path);
    migrate(fresh);
    expect(fresh.query("SELECT count(*) AS n FROM sync_cursor").get()).toEqual({ n: 0 });
    expect(fresh.query("SELECT count(*) AS n FROM __drizzle_migrations").get()).toEqual({ n: 1 });
    fresh.close();

    expect(setAsideLegacyDatabase(path, new Date(NOW.getTime() + 60_000))).toBe(null);
    expect(readdirSync(home).filter((name) => name.includes("pre-drizzle"))).toHaveLength(3);
  });

  test("leaves a missing or new database alone", () => {
    const home = tempHome();
    const path = join(home, "paws.db");
    expect(setAsideLegacyDatabase(path, NOW)).toBe(null);
    const db = openDatabase(path);
    migrate(db);
    db.close();
    expect(setAsideLegacyDatabase(path, NOW)).toBe(null);
    expect(readdirSync(home).filter((name) => name.includes("pre-drizzle"))).toEqual([]);
  });

  test("never overwrites an earlier set-aside file", () => {
    const home = tempHome();
    const path = join(home, "paws.db");
    const db = openDatabase(path);
    legacyMigrate(db);
    db.close();
    writeFileSync(`${path}.pre-drizzle-20261107T030405Z`, "earlier");
    expect(() => setAsideLegacyDatabase(path, NOW)).toThrow("already exists");
    expect(readFileSync(`${path}.pre-drizzle-20261107T030405Z`, "utf8")).toBe("earlier");
    expect(existsSync(path)).toBe(true);
  });
});

describe("migrate:dry-run", () => {
  test("reports nothing to apply on a migrated copy and refuses a legacy database untouched", () => {
    const home = tempHome();
    const current = join(home, "current.db");
    const db = openDatabase(current);
    migrate(db);
    db.close();
    expect(migrateDryRun(current)).toEqual({ applied: [] });

    const legacy = join(home, "legacy.db");
    const old = openDatabase(legacy);
    legacyMigrate(old);
    old.run("PRAGMA wal_checkpoint(TRUNCATE)");
    old.close();
    const before = readFileSync(legacy);
    expect(() => migrateDryRun(legacy)).toThrow("from before drizzle-kit migrations");
    expect(readFileSync(legacy)).toEqual(before);
  });
});
