import type { Database } from "bun:sqlite";
import { migrations } from "./migrations";

export function migrate(db: Database): void {
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
    if (applied.has(migration.id)) continue;
    const apply = db.transaction(() => {
      db.run(migration.sql);
      db.run("INSERT INTO schema_migration (id, applied_at) VALUES (?, ?)", [
        migration.id,
        Date.now(),
      ]);
    });
    apply.immediate();
  }
}
