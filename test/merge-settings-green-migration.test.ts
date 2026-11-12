import { describe, expect, test } from "bun:test";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { migrate as migratePg } from "drizzle-orm/pglite/migrator";
import { PG_MIGRATIONS_FOLDER, postgresDb } from "../src/db";
import { insertWorkItem } from "./dialects";
import { tempHome } from "./helpers";
import { pgliteDb } from "./pglite";

function beforeMigration(folder: string): string {
  const out = join(tempHome(), "migrations");
  cpSync(folder, out, { recursive: true });
  const path = join(out, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(path, "utf8")) as { entries: { tag: string }[] };
  const index = journal.entries.findIndex((entry) =>
    entry.tag.endsWith("_merge_settings_main_moved_green"),
  );
  expect(index).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, index);
  writeFileSync(path, JSON.stringify(journal));
  return out;
}

const INSERT = `INSERT INTO work_item_merge_settings
  (item_id, merge_order, main_moved, resolved_json, resolved_at) VALUES`;
const KEPT_ROW = {
  item_id: "acme-1",
  merge_order: "queue",
  main_moved: "ci",
  resolved_json: "{}",
  resolved_at: 10,
};

describe("allowing main_moved = green", () => {
  test("the Postgres constraint is replaced and keeps the rows", async () => {
    const pg = await pgliteDb({ migrationsFolder: beforeMigration(PG_MIGRATIONS_FOLDER) });
    try {
      await insertWorkItem(postgresDb(pg), "acme-1");
      await insertWorkItem(postgresDb(pg), "acme-2");
      await pg.$client.query(`${INSERT} ('acme-1', 'queue', 'ci', '{}', 10)`);
      await expect(
        pg.$client.query(`${INSERT} ('acme-2', 'queue', 'green', '{}', 10)`),
      ).rejects.toThrow();

      await migratePg(pg, { migrationsFolder: PG_MIGRATIONS_FOLDER });

      const { rows } = await pg.$client.query("SELECT * FROM work_item_merge_settings");
      expect(rows).toEqual([KEPT_ROW]);
      await pg.$client.query(`${INSERT} ('acme-2', 'queue', 'green', '{}', 10)`);
      await expect(
        pg.$client.query("UPDATE work_item_merge_settings SET main_moved = 'acme'"),
      ).rejects.toThrow();
    } finally {
      await pg.$client.close();
    }
  });
});
