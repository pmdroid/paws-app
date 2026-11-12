import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { SQL } from "bun";
import { createHash, randomUUID } from "node:crypto";
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
import {
  openPawsStore,
  openPostgres,
  PG_MIGRATIONS_FOLDER,
  pgSchema,
  postgresDb,
  type Db,
  type PgliteDb,
} from "../src/db";

const PGLITE_PACKAGE = Bun.resolveSync("@electric-sql/pglite/package.json", import.meta.dir);

const CACHE = join(dirname(PGLITE_PACKAGE), "..", "..", ".cache");

const JOURNAL = readFileSync(join(PG_MIGRATIONS_FOLDER, "meta/_journal.json"));

const TEMPLATE = join(
  CACHE,
  `paws-pglite-template-${createHash("sha256")
    .update(JOURNAL)
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

export async function tempStore(
  env: Record<string, string | undefined> = process.env,
): Promise<{ db: Db; close(): Promise<void> }> {
  const base = env.PAWS_TEST_DATABASE_URL;
  if (base) {
    const server = await serverPostgres(base, 1);
    return { db: server.store, close: server.close };
  }
  const pg = await pgliteDb();
  return { db: postgresDb(pg), close: () => pg.$client.close() };
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

type TestPostgres = { url: string; store: Db; close(): Promise<void> };

function databaseUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

async function onServer<T>(base: string, work: (admin: SQL) => Promise<T>): Promise<T> {
  const admin = new SQL({ url: base, max: 1 });
  try {
    return await work(admin);
  } finally {
    await admin.close();
  }
}

const exists = async (admin: SQL, name: string) =>
  (await admin`SELECT 1 FROM pg_database WHERE datname = ${name}`).length > 0;

const uniqueName = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;

let serverTemplate: Promise<string> | undefined;

function migratedServerTemplate(base: string): Promise<string> {
  serverTemplate ??= onServer(base, async (admin) => {
    const name = `paws_template_${createHash("sha256").update(JOURNAL).digest("hex").slice(0, 16)}`;
    if (await exists(admin, name)) return name;
    const build = uniqueName("paws_build");
    await admin.unsafe(`CREATE DATABASE ${build}`);
    const migrated = await openPawsStore({ url: databaseUrl(base, build), pgliteDir: "" });
    await migrated.close();
    try {
      await admin.unsafe(`ALTER DATABASE ${build} RENAME TO ${name}`);
    } catch (error) {
      await admin.unsafe(`DROP DATABASE ${build} WITH (FORCE)`);
      if (!(await exists(admin, name))) throw error;
    }
    return name;
  });
  return serverTemplate;
}

export async function serverPostgres(base: string, max?: number): Promise<TestPostgres> {
  const source = await migratedServerTemplate(base);
  const name = uniqueName("paws_test");
  await onServer(base, (admin) => admin.unsafe(`CREATE DATABASE ${name} TEMPLATE ${source}`));
  const url = new URL(databaseUrl(base, name));
  if (max !== undefined) url.searchParams.set("max", String(max));
  const pg = openPostgres(url.toString());
  return {
    url: url.toString(),
    store: postgresDb(pg),
    async close() {
      await pg.$client.close();
      await onServer(base, (admin) => admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`));
    },
  };
}

export async function pgliteServer(
  env: Record<string, string | undefined> = process.env,
): Promise<TestPostgres> {
  const base = env.PAWS_TEST_DATABASE_URL;
  if (base) return await serverPostgres(base);
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
