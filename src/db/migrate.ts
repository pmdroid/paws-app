import { constants, Database } from "bun:sqlite";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { migrate as drizzleMigrate } from "drizzle-orm/bun-sqlite/migrator";
import { journal, journalCaught } from "../journal";
import { orm } from "./orm";

export const MIGRATIONS_FOLDER = fileURLToPath(new URL("./drizzle", import.meta.url));
export const PG_MIGRATIONS_FOLDER = fileURLToPath(new URL("./drizzle-pg", import.meta.url));

export function migrate(db: Database, options: { migrationsFolder?: string } = {}): void {
  drizzleMigrate(orm(db), { migrationsFolder: options.migrationsFolder ?? MIGRATIONS_FOLDER });
}

export function migrationTags(migrationsFolder: string = MIGRATIONS_FOLDER): string[] {
  const file = JSON.parse(readFileSync(`${migrationsFolder}/meta/_journal.json`, "utf8")) as {
    entries: { tag: string }[];
  };
  return file.entries.map((entry) => entry.tag);
}

export function appliedMigrations(db: Database): { latest: string | null; applied: number } {
  const recorded = db
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'")
    .get();
  const applied = recorded
    ? db.query<{ n: number }, []>("SELECT count(*) AS n FROM __drizzle_migrations").get()!.n
    : 0;
  return { latest: applied === 0 ? null : (migrationTags()[applied - 1] ?? null), applied };
}

const SIDE_FILES = ["-wal", "-shm"];

/**
 * Whether `path` was built by the migrations from before drizzle-kit. Leaves the disk as it found
 * it: a plain read-only open of a WAL database creates its -wal and -shm files, so a database with
 * no -wal, whose main file is therefore complete, is opened immutable. Immutable skips locking, so
 * an open that fails falls back to a locked read, and `locked` forces one before a rename.
 */
export function isLegacyDatabase(path: string, locked = false): boolean {
  if (!existsSync(path)) return false;
  if (!locked && !existsSync(`${path}-wal`)) {
    try {
      return hasLegacyTables(
        new Database(
          `${pathToFileURL(path).href}?immutable=1`,
          constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI,
        ),
      );
    } catch (error) {
      // Another process may be writing it; read it with locks below.
      journalCaught(error, "migrate.isLegacyDatabase.immutable", null);
    }
  }
  return hasLegacyTables(new Database(path, { readonly: true }));
}

function hasLegacyTables(old: Database): boolean {
  try {
    const names = new Set(
      old
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('schema_migration', '__drizzle_migrations')",
        )
        .all()
        .map((row) => row.name),
    );
    return names.has("schema_migration") && !names.has("__drizzle_migrations");
  } finally {
    old.close();
  }
}

/**
 * Renames a legacy database so Paws starts on an empty one. That loses everything Paws knows, so
 * it throws, changing nothing, unless the operator set PAWS_RESET_LEGACY_DATABASE=1.
 */
export function setAsideLegacyDatabase(
  path: string,
  source: Record<string, string | undefined>,
  now: Date = new Date(),
): string | null {
  if (!isLegacyDatabase(path)) return null;
  if (source.PAWS_RESET_LEGACY_DATABASE !== "1")
    throw new Error(
      `${path} is from before drizzle-kit migrations and cannot be carried over. Paws would start on an empty database, and the workspace, members, runners and items in this one would be lost. Paws changed nothing. To set this database aside and start empty, set PAWS_RESET_LEGACY_DATABASE=1 and start Paws again.`,
    );
  if (!isLegacyDatabase(path, true)) return null;
  const target = renameDatabase(path, "pre-drizzle", now);
  journal(
    `database reset: the database from before drizzle-kit migrations was renamed to ${target}; Paws starts on a fresh database`,
  );
  return target;
}

function renameDatabase(path: string, label: string, now: Date): string {
  const target = `${path}.${label}-${now.toISOString().replace(/[-:]|\.\d+/g, "")}`;
  for (const suffix of ["", ...SIDE_FILES])
    if (existsSync(target + suffix)) throw new Error(`${target + suffix} already exists`);
  for (const suffix of SIDE_FILES)
    if (existsSync(path + suffix)) renameSync(path + suffix, target + suffix);
  renameSync(path, target);
  return target;
}

export function setAsideSqliteDatabase(path: string, now: Date = new Date()): string | null {
  if (!existsSync(path)) return null;
  const target = renameDatabase(path, "pre-postgres", now);
  journal(
    `database moved to Postgres: the SQLite database was renamed to ${target}; Paws starts on a fresh database`,
  );
  return target;
}
