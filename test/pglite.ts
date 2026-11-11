import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { openPawsStore, PG_MIGRATIONS_FOLDER, pgSchema, type Db, type PgliteDb } from "../src/db";

export async function pgliteDb(
  options: { migrationsFolder?: string; migrated?: boolean } = {},
): Promise<PgliteDb> {
  const client = new PGlite({ extensions: { citext } });
  const db = drizzle({ client, schema: pgSchema });
  if (options.migrated !== false)
    await migrate(db, { migrationsFolder: options.migrationsFolder ?? PG_MIGRATIONS_FOLDER });
  return db;
}

export async function pgliteServer(): Promise<{ url: string; store: Db; close(): Promise<void> }> {
  const client = await PGlite.create({ extensions: { citext } });
  const server = new PGLiteSocketServer({
    db: client,
    host: "127.0.0.1",
    port: 0,
    maxConnections: 8,
  });
  await server.start();
  const url = `postgres://postgres@${server.getServerConn()}/postgres?max=1&prepare=false`;
  const database = await openPawsStore({ url, pgliteDir: "" });
  return {
    url,
    store: database.store,
    async close() {
      await database.close();
      await server.stop();
      await client.close();
    },
  };
}
