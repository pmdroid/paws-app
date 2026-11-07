import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { PG_MIGRATIONS_FOLDER, pgSchema } from "../src/db";

export type PgliteDb = PgliteDatabase<typeof pgSchema> & { $client: PGlite };

export async function pgliteDb(
  options: { migrationsFolder?: string; migrated?: boolean } = {},
): Promise<PgliteDb> {
  const client = new PGlite({ extensions: { citext } });
  const db = drizzle({ client, schema: pgSchema });
  if (options.migrated !== false)
    await migrate(db, { migrationsFolder: options.migrationsFolder ?? PG_MIGRATIONS_FOLDER });
  return db;
}
