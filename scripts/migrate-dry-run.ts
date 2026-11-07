/**
 * Runs the pending migrations on a copy of a Paws database and leaves the
 * original untouched.
 *
 *   bun scripts/migrate-dry-run.ts            # ~/.paws/paws.db
 *   bun scripts/migrate-dry-run.ts path/to.db
 *
 * The copy is taken with `VACUUM INTO`, so a running Paws keeps its WAL. The
 * script prints the migrations it applied, or the error that stopped one, and
 * deletes the copy.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS_FOLDER, migrate, openDatabase } from "../src/db";

export function migrateDryRun(source: string): { applied: string[] } {
  if (!existsSync(source)) throw new Error(`No database at ${source}`);
  const dir = mkdtempSync(join(tmpdir(), "paws-migrate-"));
  const copy = join(dir, "paws.db");
  try {
    const original = new Database(source, { readonly: true });
    try {
      original.run("VACUUM INTO ?", [copy]);
    } finally {
      original.close();
    }
    const db = openDatabase(copy);
    try {
      if (isLegacy(db))
        throw new Error(
          "This database is from before drizzle-kit migrations; Paws sets it aside and starts on a fresh one",
        );
      const before = appliedCount(db);
      migrate(db);
      const problems = db.query("PRAGMA foreign_key_check").all();
      if (problems.length > 0)
        throw new Error(`Foreign key check failed: ${JSON.stringify(problems)}`);
      return { applied: migrationTags().slice(before, appliedCount(db)) };
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function isLegacy(db: Database): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE name = 'schema_migration'").get() !== null;
}

function appliedCount(db: Database): number {
  const table = db.query("SELECT 1 FROM sqlite_master WHERE name = '__drizzle_migrations'").get();
  if (!table) return 0;
  return db.query<{ n: number }, []>("SELECT count(*) AS n FROM __drizzle_migrations").get()!.n;
}

function migrationTags(): string[] {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta/_journal.json"), "utf8"));
  return (journal.entries as { tag: string }[]).map((entry) => entry.tag);
}

if (import.meta.main) {
  const source =
    process.argv[2] ?? join(process.env.PAWS_HOME ?? join(homedir(), ".paws"), "paws.db");
  try {
    const { applied } = migrateDryRun(source);
    console.log(
      applied.length > 0
        ? `Dry run passed on a copy of ${source}. Applied: ${applied.join(", ")}`
        : `Dry run passed on a copy of ${source}. Nothing to apply.`,
    );
  } catch (error) {
    console.error(`Dry run failed on a copy of ${source}: ${(error as Error).message}`);
    process.exit(1);
  }
}
