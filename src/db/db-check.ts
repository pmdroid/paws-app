import { sql, type SQL } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { PG_MIGRATIONS_FOLDER, migrationTags } from "./migrate";

export type PostgresConnection = {
  db: { execute(query: SQL): PromiseLike<unknown> };
  migrate(): Promise<void>;
  close(): Promise<void>;
};

export type MigrationReport = { applied: number; known: number };

function migrationDrift(hashes: readonly string[]): MigrationReport {
  const files = readMigrationFiles({ migrationsFolder: PG_MIGRATIONS_FOLDER });
  const tags = migrationTags(PG_MIGRATIONS_FOLDER);
  if (hashes.length > files.length)
    throw new Error(
      `the database has ${hashes.length} migrations applied, but this Paws knows ${files.length}`,
    );
  hashes.forEach((hash, index) => {
    if (hash !== files[index]!.hash)
      throw new Error(`migration ${tags[index]} differs from the one the database applied`);
  });
  return { applied: hashes.length, known: files.length };
}

function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : (result as { rows: T[] }).rows;
}

export async function checkPostgres(
  connection: PostgresConnection,
): Promise<MigrationReport & { serverVersion: string }> {
  await connection.migrate();
  const recorded = rowsOf<{ hash: string }>(
    await connection.db.execute(
      sql`SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at`,
    ),
  );
  const report = migrationDrift(recorded.map((row) => row.hash));
  if (report.applied < report.known)
    throw new Error(`${report.known - report.applied} migrations did not apply`);
  const [version] = rowsOf<{ server_version: string }>(
    await connection.db.execute(sql`SHOW server_version`),
  );
  if (!version) throw new Error("the server did not report its version");
  return { ...report, serverVersion: version.server_version };
}
