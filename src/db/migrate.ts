import type { Database } from "bun:sqlite";
import { migrations } from "./migrations";

/** Applies pending migrations in order. `until` stops after that id, for migration tests. */
export function migrate(db: Database, options: { until?: string } = {}): void {
  if (options.until !== undefined && !migrations.some((m) => m.id === options.until))
    throw new Error(`Unknown migration ${options.until}`);
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    ) STRICT
  `);
  const applied = new Set(
    db
      .query<{ id: string }, []>("SELECT id FROM schema_migration")
      .all()
      .map((row) => row.id),
  );
  for (const migration of migrations) {
    if (applied.has(migration.id)) {
      if (migration.id === options.until) return;
      continue;
    }
    const foreignKeys =
      db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys ?? 1;
    if (migration.foreignKeys === false && db.inTransaction)
      throw new Error("Identity migration requires its own transaction");
    if (migration.foreignKeys === false) db.run("PRAGMA foreign_keys = OFF");
    try {
      const apply = db.transaction(() => {
        migration.guard?.(db);
        db.run(migration.sql);
        if (
          migration.foreignKeys === false &&
          db.query("PRAGMA foreign_key_check").all().length > 0
        )
          throw new Error("Identity migration would break foreign keys");
        db.run("INSERT INTO schema_migration (id, applied_at) VALUES (?, ?)", [
          migration.id,
          Date.now(),
        ]);
      });
      apply.immediate();
    } finally {
      if (migration.foreignKeys === false)
        db.run(`PRAGMA foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
    }
    if (migration.id === options.until) return;
  }
}
