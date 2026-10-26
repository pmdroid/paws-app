import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  combineMigrations,
  frozenMigrations,
  loadMigrationFiles,
  migrate,
  migrations,
  openDatabase,
  type Migration,
} from "../src/db";
import { tempHome } from "./helpers";

function migrationFile(directory: string, id: string, sql: string, exportedId = id): void {
  writeFileSync(
    join(directory, `${id}.ts`),
    `export const migration = { id: ${JSON.stringify(exportedId)}, sql: ${JSON.stringify(sql)} };\n`,
  );
}

function git(cwd: string, ...args: string[]): { code: number; output: string } {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Paws test",
      GIT_AUTHOR_EMAIL: "paws@example.invalid",
      GIT_COMMITTER_NAME: "Paws test",
      GIT_COMMITTER_EMAIL: "paws@example.invalid",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  return { code: result.exitCode, output: `${result.stdout}${result.stderr}` };
}

function schema(list: readonly Migration[], order: string[][]): unknown[] {
  const db = openDatabase(":memory:");
  try {
    for (const ids of order) {
      const known = new Set(ids);
      migrate(db, {
        migrations: list.filter((m) => known.has(m.id) || frozenMigrations.includes(m)),
      });
    }
    return db
      .query(
        "SELECT type, name, sql FROM sqlite_master WHERE name <> 'schema_migration' ORDER BY name",
      )
      .all();
  } finally {
    db.close();
  }
}

describe("migration files", () => {
  test("the frozen list ends at 155_pull_comment; a new migration is a file", () => {
    const ids = frozenMigrations.map((m) => m.id);
    if (ids.length !== 164 || ids.at(-1) !== "155_pull_comment")
      throw new Error(
        `src/db/migrations.ts is frozen at 164 entries ending at 155_pull_comment, but it now ends at ${ids.at(-1)} (${ids.length} entries). Do not add to that array: add a file under src/db/migrations/ named <yyyymmdd>T<hhmm>_<name>.ts instead (see src/db/migrations/README.md).`,
      );
    expect(migrations.slice(0, 164)).toEqual([...frozenMigrations]);
  });

  test("loads files sorted by id after the frozen list", () => {
    const directory = tempHome();
    migrationFile(directory, "20261026T1200_second", "CREATE TABLE second (id INTEGER) STRICT;");
    migrationFile(directory, "20261026T0900_first", "CREATE TABLE first (id INTEGER) STRICT;");
    writeFileSync(join(directory, "README.md"), "not a migration\n");
    const files = loadMigrationFiles(directory);
    expect(files.map((m) => m.id)).toEqual(["20261026T0900_first", "20261026T1200_second"]);
    const all = combineMigrations(frozenMigrations, files);
    expect(all.at(-3)?.id).toBe("155_pull_comment");
    expect(loadMigrationFiles(join(directory, "missing"))).toEqual([]);
  });

  test("a file whose id does not match its name fails", () => {
    const directory = tempHome();
    migrationFile(directory, "20261026T0900_first", "SELECT 1;", "20261026T0900_other");
    expect(() => loadMigrationFiles(directory)).toThrow(
      "exports id 20261026T0900_other; its id must be 20261026T0900_first",
    );
  });

  test("a misnamed file fails", () => {
    for (const name of ["156_pull_comment", "2026-10-26_pull_comment", "20261026T0900_Pull"]) {
      const directory = tempHome();
      migrationFile(directory, name, "SELECT 1;");
      expect(() => loadMigrationFiles(directory)).toThrow(
        `Migration file ${name}.ts must be named`,
      );
    }
  });

  test("a duplicate id fails", () => {
    const [first] = frozenMigrations;
    if (!first) throw new Error("no frozen migrations");
    expect(() => combineMigrations(frozenMigrations, [{ ...first }])).toThrow(
      "Duplicate migration id 001_jobs_outbox",
    );
  });

  test("two files applied in either order end with the same schema", () => {
    const directory = tempHome();
    migrationFile(directory, "20261026T0900_alpha", "CREATE TABLE alpha (id INTEGER) STRICT;");
    migrationFile(
      directory,
      "20261026T1200_beta",
      "CREATE TABLE beta (id INTEGER) STRICT; CREATE INDEX beta_id ON beta(id);",
    );
    const list = combineMigrations(frozenMigrations, loadMigrationFiles(directory));
    const alphaFirst = schema(list, [
      ["20261026T0900_alpha"],
      ["20261026T0900_alpha", "20261026T1200_beta"],
    ]);
    // beta merges first and is applied; alpha, with the earlier id, still applies afterwards.
    const betaFirst = schema(list, [
      ["20261026T1200_beta"],
      ["20261026T0900_alpha", "20261026T1200_beta"],
    ]);
    expect(betaFirst).toEqual(alphaFirst);
    expect(alphaFirst.map((row) => (row as { name: string }).name)).toEqual(
      expect.arrayContaining(["alpha", "beta", "beta_id"]),
    );
  });

  test("two branches that each add a migration file merge in either order without a conflict", () => {
    const root = tempHome();
    expect(git(root, "init", "-q", "-b", "main").code).toBe(0);
    mkdirSync(join(root, "migrations"));
    writeFileSync(join(root, "migrations", "README.md"), "Migrations\n");
    git(root, "add", ".");
    expect(git(root, "commit", "-qm", "base").code).toBe(0);
    for (const [branch, id] of [
      ["alpha", "20261026T0900_alpha"],
      ["beta", "20261026T0900_beta"],
    ] as const) {
      git(root, "checkout", "-qb", branch, "main");
      migrationFile(join(root, "migrations"), id, `CREATE TABLE ${branch} (id INTEGER) STRICT;`);
      git(root, "add", ".");
      expect(git(root, "commit", "-qm", branch).code).toBe(0);
    }
    for (const [first, second] of [
      ["alpha", "beta"],
      ["beta", "alpha"],
    ]) {
      git(root, "checkout", "-qB", `merge-${first}`, "main");
      expect(git(root, "merge", "-q", "--no-edit", first ?? "").code).toBe(0);
      const merged = git(root, "merge", "-q", "--no-edit", second ?? "");
      expect(merged).toEqual({ code: 0, output: "" });
      expect(loadMigrationFiles(join(root, "migrations")).map((m) => m.id)).toEqual([
        "20261026T0900_alpha",
        "20261026T0900_beta",
      ]);
    }
  });
});
