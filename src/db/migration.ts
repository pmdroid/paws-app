import type { Database } from "bun:sqlite";

export type Migration = {
  id: string;
  sql: string;
  foreignKeys?: false;
  /** Runs in the migration's transaction before `sql`. Throw to stop the migration. */
  guard?: (db: Database) => void;
};
