import { SQL } from "bun";
import { drizzle, type BunSQLDatabase } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { PG_MIGRATIONS_FOLDER } from "./migrate";
import * as pgSchema from "./schema-pg";
import type { PostgresConnection } from "./db-check";

export type PostgresDb = BunSQLDatabase<typeof pgSchema> & { $client: SQL };

export function openPostgres(url: string): PostgresDb {
  const client = new SQL({ url, max: 10, idleTimeout: 30, connectionTimeout: 10, maxLifetime: 0 });
  return drizzle({ client, schema: pgSchema });
}

export function connectPostgres(url: string): PostgresConnection {
  const db = openPostgres(url);
  return {
    db,
    migrate: () => migrate(db, { migrationsFolder: PG_MIGRATIONS_FOLDER }),
    close: () => db.$client.close(),
  };
}
