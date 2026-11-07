import { Database } from "bun:sqlite";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

export function setAsideLegacyDatabase(path: string, now: Date = new Date()): string | null {
  if (!existsSync(path)) return null;
  const old = new Database(path, { readonly: true });
  let legacy: boolean;
  try {
    const names = new Set(
      old
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('schema_migration', '__drizzle_migrations')",
        )
        .all()
        .map((row) => row.name),
    );
    legacy = names.has("schema_migration") && !names.has("__drizzle_migrations");
  } finally {
    old.close();
  }
  if (!legacy) return null;
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
