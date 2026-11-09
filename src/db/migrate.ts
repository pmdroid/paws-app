import { constants, Database } from "bun:sqlite";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { migrate as drizzleMigrate } from "drizzle-orm/bun-sqlite/migrator";
import { journal } from "../journal";
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
 * no -wal, whose main file is therefore complete, is opened immutable.
 */
export function isLegacyDatabase(path: string): boolean {
  if (!existsSync(path)) return false;
  const old = existsSync(`${path}-wal`)
    ? new Database(path, { readonly: true })
    : new Database(
        `${pathToFileURL(path).href}?immutable=1`,
        constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI,
      );
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
  const target = `${path}.pre-drizzle-${now.toISOString().replace(/[-:]|\.\d+/g, "")}`;
  for (const suffix of ["", ...SIDE_FILES])
    if (existsSync(target + suffix)) throw new Error(`${target + suffix} already exists`);
  for (const suffix of SIDE_FILES)
    if (existsSync(path + suffix)) renameSync(path + suffix, target + suffix);
  renameSync(path, target);
  journal(
    `database reset: the database from before drizzle-kit migrations was renamed to ${target}; Paws starts on a fresh database`,
  );
  return target;
}

export function recordedMigrationHashes(path: string): string[] | null {
  if (!existsSync(path)) return null;
  const db = new Database(path, { readonly: true });
  try {
    const recorded = db
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'")
      .get();
    if (!recorded) return [];
    return db
      .query<{ hash: string }, []>("SELECT hash FROM __drizzle_migrations ORDER BY created_at")
      .all()
      .map((row) => row.hash);
  } finally {
    db.close();
  }
}
