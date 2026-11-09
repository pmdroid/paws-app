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
import { startPaws, useSavedSettings } from "../src/index";
import { setJournalSink } from "../src/journal";
import { shutdownPaws } from "../src/shutdown";
import { migrateDryRun } from "../scripts/migrate-dry-run";
import { tempHome } from "./helpers";

const ROOT = new URL("..", import.meta.url).pathname;
const NOW = new Date("2026-11-07T03:04:05.678Z");
const RESET = { PAWS_RESET_LEGACY_DATABASE: "1" };
const SHIPPED = readdirSync(MIGRATIONS_FOLDER)
  .filter((name) => name.endsWith(".sql"))
  .sort();

function legacyDatabase(home: string) {
  const path = join(home, "paws.db");
  const db = openDatabase(path);
  legacyMigrate(db);
  db.run("PRAGMA wal_autocheckpoint = 0");
  db.run("INSERT INTO sync_cursor (name, cursor_ms) VALUES ('legacy', 1)");
  expect(existsSync(`${path}-shm`)).toBe(true);
  return { path, db, file: readFileSync(path), wal: readFileSync(`${path}-wal`) };
}

function closedLegacyDatabase(home: string) {
  const path = join(home, "paws.db");
  const db = openDatabase(path);
  legacyMigrate(db);
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  return path;
}

function refusal(path: string) {
  return `${path} is from before drizzle-kit migrations and cannot be carried over. Paws would start on an empty database, and the workspace, members, runners and items in this one would be lost. Paws changed nothing. To set this database aside and start empty, set PAWS_RESET_LEGACY_DATABASE=1 and start Paws again.`;
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

describe("a database from the legacy migrations", () => {
  test("is renamed with its WAL and SHM files, untouched, and Paws starts fresh", () => {
    const home = tempHome();
    const legacy = legacyDatabase(home);
    const { path } = legacy;
    const lines: string[] = [];
    const restore = setJournalSink((line) => lines.push(line));
    let moved: string | null;
    try {
      moved = setAsideLegacyDatabase(path, RESET, NOW);
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
    expect(fresh.query("SELECT count(*) AS n FROM __drizzle_migrations").get()).toEqual({
      n: SHIPPED.length,
    });
    fresh.close();

    expect(setAsideLegacyDatabase(path, RESET, new Date(NOW.getTime() + 60_000))).toBe(null);
    expect(readdirSync(home).filter((name) => name.includes("pre-drizzle"))).toHaveLength(3);
  });

  test("stops startup without the opt-in and changes nothing on disk", () => {
    const home = tempHome();
    const path = closedLegacyDatabase(home);
    writeFileSync(join(home, "config.toml"), "");
    const before = readFileSync(path);
    const release = useSavedSettings();
    try {
      for (const flag of [undefined, "", "0", "true"])
        expect(() =>
          startPaws({ PAWS_HOME: home, PAWS_PORT: "0", PAWS_RESET_LEGACY_DATABASE: flag }),
        ).toThrow(refusal(path));
    } finally {
      release();
    }
    expect(readdirSync(home).sort()).toEqual(["config.toml", "paws.db"]);
    expect(readFileSync(path)).toEqual(before);
  });

  test("refuses one with a live WAL and leaves its files as they were", () => {
    const legacy = legacyDatabase(tempHome());
    expect(() => setAsideLegacyDatabase(legacy.path, {}, NOW)).toThrow(refusal(legacy.path));
    expect(readFileSync(legacy.path)).toEqual(legacy.file);
    expect(readFileSync(`${legacy.path}-wal`)).toEqual(legacy.wal);
    legacy.db.close();
  });

  test("is renamed at startup with the opt-in", async () => {
    const home = tempHome();
    const path = closedLegacyDatabase(home);
    const before = readFileSync(path);
    const paws = startPaws({ PAWS_HOME: home, PAWS_PORT: "0", ...RESET });
    await shutdownPaws(paws, 0, () => {});
    const renamed = readdirSync(home).filter((name) => /pre-drizzle-\d+T\d+Z$/.test(name));
    expect(renamed).toHaveLength(1);
    expect(readFileSync(join(home, renamed[0]!))).toEqual(before);
    expect(existsSync(path)).toBe(true);
  });

  for (const [name, source] of [
    ["without", {}],
    ["with", RESET],
  ] as const)
    test(`leaves a missing or new database alone ${name} the opt-in`, () => {
      const home = tempHome();
      const path = join(home, "paws.db");
      expect(setAsideLegacyDatabase(path, source, NOW)).toBe(null);
      const db = openDatabase(path);
      migrate(db);
      db.close();
      expect(setAsideLegacyDatabase(path, source, NOW)).toBe(null);
      expect(readdirSync(home).filter((name) => name.includes("pre-drizzle"))).toEqual([]);
    });

  test("never overwrites an earlier set-aside file", () => {
    const home = tempHome();
    const path = join(home, "paws.db");
    const db = openDatabase(path);
    legacyMigrate(db);
    db.close();
    writeFileSync(`${path}.pre-drizzle-20261107T030405Z`, "earlier");
    expect(() => setAsideLegacyDatabase(path, RESET, NOW)).toThrow("already exists");
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
