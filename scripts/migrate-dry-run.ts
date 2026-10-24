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
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, migrations, openDatabase } from "../src/db";

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
      const before = appliedIds(db);
      migrate(db);
      const after = appliedIds(db);
      const problems = db.query("PRAGMA foreign_key_check").all();
      if (problems.length > 0)
        throw new Error(`Foreign key check failed: ${JSON.stringify(problems)}`);
      return {
        applied: migrations.map((m) => m.id).filter((id) => after.has(id) && !before.has(id)),
      };
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function appliedIds(db: Database): Set<string> {
  const table = db.query("SELECT 1 FROM sqlite_master WHERE name='schema_migration'").get();
  if (!table) return new Set();
  return new Set(
    db
      .query<{ id: string }, []>("SELECT id FROM schema_migration")
      .all()
      .map((row) => row.id),
  );
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
