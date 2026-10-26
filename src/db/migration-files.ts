import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Migration } from "./migration";
import { frozenMigrations } from "./migrations";

/**
 * New migrations live one per file in this directory, so two branches that each add one
 * never edit the same lines. The file name is the id: a UTC timestamp to the minute and a
 * name, `20261026T0512_pull_comment.ts`, exporting `migration` with that id.
 */
export const MIGRATION_DIRECTORY = fileURLToPath(new URL("./migrations/", import.meta.url));

const FILE_NAME = /^(\d{8}T\d{4}_[a-z0-9]+(?:_[a-z0-9]+)*)\.ts$/;

/** The migration files in `directory`, sorted by id. Throws on a misnamed file or a wrong id. */
export function loadMigrationFiles(directory: string = MIGRATION_DIRECTORY): Migration[] {
  if (!existsSync(directory)) return [];
  const loaded: Migration[] = [];
  for (const name of readdirSync(directory).sort()) {
    if (!name.endsWith(".ts")) continue;
    const id = FILE_NAME.exec(name)?.[1];
    if (id === undefined)
      throw new Error(
        `Migration file ${name} must be named <yyyymmdd>T<hhmm>_<name>.ts with a UTC time, for example 20261026T0512_pull_comment.ts`,
      );
    const module = require(join(directory, name)) as { migration?: Migration };
    const migration = module.migration;
    if (migration === undefined || typeof migration.sql !== "string")
      throw new Error(`Migration file ${name} must export \`migration\``);
    if (migration.id !== id)
      throw new Error(`Migration file ${name} exports id ${migration.id}; its id must be ${id}`);
    loaded.push(migration);
  }
  return loaded;
}

/** The frozen list followed by the files. Throws on a duplicate id. */
export function combineMigrations(
  frozen: readonly Migration[],
  files: readonly Migration[],
): readonly Migration[] {
  const all = [...frozen, ...files];
  const seen = new Set<string>();
  for (const { id } of all) {
    if (seen.has(id)) throw new Error(`Duplicate migration id ${id}`);
    seen.add(id);
  }
  return all;
}

/** Every migration Paws applies, in order. */
export const migrations: readonly Migration[] = combineMigrations(
  frozenMigrations,
  loadMigrationFiles(),
);
