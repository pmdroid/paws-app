import { existsSync, readFileSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { journal } from "../journal";

export const PG_MIGRATIONS_FOLDER = fileURLToPath(new URL("./drizzle-pg", import.meta.url));

export function migrationTags(migrationsFolder: string): string[] {
  const file = JSON.parse(readFileSync(`${migrationsFolder}/meta/_journal.json`, "utf8")) as {
    entries: { tag: string }[];
  };
  return file.entries.map((entry) => entry.tag);
}

const SIDE_FILES = ["-wal", "-shm"];

/**
 * Whether `path` was built by the migrations from before drizzle-kit. Leaves the disk as it found
 * it: a plain read-only open of a WAL database creates its -wal and -shm files, so a database with
 * no -wal, whose main file is therefore complete, is opened immutable. Immutable skips locking, so
 * an open that fails falls back to a locked read, and `locked` forces one before a rename.
 */
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
