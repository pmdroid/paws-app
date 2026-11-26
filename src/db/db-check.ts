import { sql, type SQL } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { PG_MIGRATIONS_FOLDER } from "./migrate";

function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : (result as { rows: T[] }).rows;
}

export class UnknownDatabaseError extends Error {
  constructor(readonly newer: boolean) {
    super(
      newer
        ? "This database was created by a newer Paws. Start that version or reset it."
        : "This database was created by an older Paws. Reset it to start this version.",
    );
  }
}

export async function refuseOlderDatabase(db: {
  execute(query: SQL): PromiseLike<unknown>;
}): Promise<void> {
  const [table] = rowsOf<{ name: string | null }>(
    await db.execute(sql`SELECT to_regclass('drizzle.__drizzle_migrations')::text AS name`),
  );
  if (!table?.name) return;
  const recorded = rowsOf<{ hash: string; created_at: string | number | null }>(
    await db.execute(sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations`),
  );
  const files = readMigrationFiles({ migrationsFolder: PG_MIGRATIONS_FOLDER });
  const known = new Set(files.map((file) => file.hash));
  const unknown = recorded.filter((row) => !known.has(row.hash));
  if (unknown.length === 0) return;
  const baseline = files[0]!.folderMillis;
  throw new UnknownDatabaseError(unknown.some((row) => Number(row.created_at) > baseline));
}
