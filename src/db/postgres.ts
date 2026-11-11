import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { SQL } from "bun";
import { drizzle, type BunSQLDatabase } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { drizzle as drizzlePglite, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { PG_MIGRATIONS_FOLDER } from "./migrate";
import * as pgSchema from "./schema-pg";
import type { PostgresConnection } from "./db-check";
import { postgresDb, type PgDb } from "./db";

export type PostgresDb = BunSQLDatabase<typeof pgSchema> & { $client: SQL };

export type PgliteDb = PgliteDatabase<typeof pgSchema> & { $client: PGlite };

export function openPostgres(url: string): PostgresDb {
  const max = Number(new URL(url).searchParams.get("max") ?? 10);
  const client = new SQL({ url, max, idleTimeout: 30, connectionTimeout: 10, maxLifetime: 0 });
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

export class PgliteInUseError extends Error {
  constructor(
    readonly dir: string,
    readonly pid: number,
  ) {
    super(`PGlite ${dir} is in use by process ${pid}`);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function lockPglite(dir: string): () => void {
  const lock = `${dir}.lock`;
  for (let attempt = 0; ; attempt += 1) {
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
      return () => rmSync(lock, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const holder = existsSync(lock) ? Number(readFileSync(lock, "utf8")) : 0;
    if (attempt > 0 || (holder > 0 && holder !== process.pid && alive(holder)))
      throw new PgliteInUseError(dir, holder);
    rmSync(lock, { force: true });
  }
}

export function connectPglite(dir: string): PostgresConnection {
  const release = lockPglite(dir);
  try {
    const client = new PGlite(dir, { extensions: { citext } });
    const db = drizzlePglite({ client, schema: pgSchema });
    return {
      db,
      migrate: () => migratePglite(db, { migrationsFolder: PG_MIGRATIONS_FOLDER }),
      close: () => client.close().finally(release),
    };
  } catch (error) {
    release();
    throw error;
  }
}

export async function openPglite(dir: string): Promise<PgliteDb> {
  const client = new PGlite(dir, { extensions: { citext } });
  const db = drizzlePglite({ client, schema: pgSchema });
  try {
    await migratePglite(db, { migrationsFolder: PG_MIGRATIONS_FOLDER });
  } catch (error) {
    await client.close();
    throw error;
  }
  return db;
}

export type PawsStore = { store: PgDb; close(): Promise<void> };

export async function openPawsStore(input: {
  url: string | null;
  pgliteDir: string;
}): Promise<PawsStore> {
  if (input.url === null) {
    const release = lockPglite(input.pgliteDir);
    try {
      const pg = await openPglite(input.pgliteDir);
      return { store: postgresDb(pg), close: () => pg.$client.close().finally(release) };
    } catch (error) {
      release();
      throw error;
    }
  }
  const db = openPostgres(input.url);
  try {
    await migrate(db, { migrationsFolder: PG_MIGRATIONS_FOLDER });
  } catch (error) {
    await db.$client.close();
    throw error;
  }
  return { store: postgresDb(db), close: () => db.$client.close() };
}
