import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openPawsStore, PG_MIGRATIONS_FOLDER, pgSchema, type Db, type PgliteDb } from "../src/db";

const PGLITE_PACKAGE = Bun.resolveSync("@electric-sql/pglite/package.json", import.meta.dir);

const CACHE = join(dirname(PGLITE_PACKAGE), "..", "..", ".cache");

const TEMPLATE = join(
  CACHE,
  `paws-pglite-template-${createHash("sha256")
    .update(readFileSync(join(PG_MIGRATIONS_FOLDER, "meta/_journal.json")))
    .update(readFileSync(PGLITE_PACKAGE))
    .digest("hex")
    .slice(0, 16)}`,
);

let template: Promise<string> | undefined;

export function migratedTemplate(): Promise<string> {
  template ??= (async () => {
    if (existsSync(join(TEMPLATE, "PG_VERSION"))) return TEMPLATE;
    mkdirSync(CACHE, { recursive: true });
    const work = mkdtempSync(join(CACHE, "paws-pglite-build-"));
    const dir = join(work, "pglite");
    const client = new PGlite(dir, { extensions: { citext } });
    await migrate(drizzle({ client, schema: pgSchema }), {
      migrationsFolder: PG_MIGRATIONS_FOLDER,
    });
    await client.close();
    try {
      renameSync(dir, TEMPLATE);
    } catch (error) {
      if (!existsSync(join(TEMPLATE, "PG_VERSION"))) throw error;
    }
    rmSync(work, { recursive: true, force: true });
    return TEMPLATE;
  })();
  return template;
}

export async function copyMigratedPglite(dir: string): Promise<void> {
  cpSync(await migratedTemplate(), dir, { recursive: true });
}

let dump: Promise<Blob> | undefined;

function migratedDump(): Promise<Blob> {
  dump ??= (async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "paws-pglite-dump-")), "pglite");
    await copyMigratedPglite(dir);
    const client = await PGlite.create(dir, { extensions: { citext } });
    const blob = await client.dumpDataDir("none");
    await client.close();
    rmSync(join(dir, ".."), { recursive: true, force: true });
    return blob;
  })();
  return dump;
}

async function migratedClient(): Promise<PGlite> {
  return await PGlite.create({ extensions: { citext }, loadDataDir: await migratedDump() });
}

export async function pgliteDb(
  options: { migrationsFolder?: string; migrated?: boolean } = {},
): Promise<PgliteDb> {
  if (options.migrated !== false && options.migrationsFolder === undefined)
    return drizzle({ client: await migratedClient(), schema: pgSchema });
  const client = new PGlite({ extensions: { citext } });
  const db = drizzle({ client, schema: pgSchema });
  if (options.migrated !== false)
    await migrate(db, { migrationsFolder: options.migrationsFolder ?? PG_MIGRATIONS_FOLDER });
  return db;
}

const EXTENDED = new Set([..."PBDECH"].map((type) => type.charCodeAt(0)));

function syncedSession(client: PGlite): PGlite {
  let unsynced = false;
  return new Proxy(client, {
    get(target, property) {
      if (property === "isInTransaction") return () => unsynced || target.isInTransaction();
      if (property === "execProtocolRawStream")
        return (message: Uint8Array, options: Parameters<PGlite["execProtocolRawStream"]>[1]) => {
          unsynced = EXTENDED.has(message[0]!);
          return target.execProtocolRawStream(message, options);
        };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export async function pgliteServer(): Promise<{ url: string; store: Db; close(): Promise<void> }> {
  const client = await migratedClient();
  const server = new PGLiteSocketServer({
    db: syncedSession(client),
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
