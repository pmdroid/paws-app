import { readFileSync } from "node:fs";
import { assetPath } from "../assets";

export const PG_MIGRATIONS_FOLDER = assetPath("src/db/drizzle-pg");

export function migrationTags(migrationsFolder: string): string[] {
  const file = JSON.parse(readFileSync(`${migrationsFolder}/meta/_journal.json`, "utf8")) as {
    entries: { tag: string }[];
  };
  return file.entries.map((entry) => entry.tag);
}
