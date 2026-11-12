import { describe, expect, test } from "bun:test";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { migrate as migratePg } from "drizzle-orm/pglite/migrator";
import { PG_MIGRATIONS_FOLDER, postgresDb } from "../src/db";
import { insertWorkItem } from "./dialects";
import { tempHome } from "./helpers";
import { pgliteDb } from "./pglite";

const TAG = "one_wait_table";

function before(folder: string): string {
  const out = join(tempHome(), "migrations");
  cpSync(folder, out, { recursive: true });
  const path = join(out, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(path, "utf8")) as { entries: { tag: string }[] };
  const index = journal.entries.findIndex((entry) => entry.tag.endsWith(`_${TAG}`));
  expect(index).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, index);
  writeFileSync(path, JSON.stringify(journal));
  return out;
}

const OLD_ROWS = [
  "INSERT INTO item_wait (item_id, version, since) VALUES ('a', 3, 100), ('b', 1, 200)",
  "INSERT INTO queue_wait (item_id, version, since) VALUES ('a', 2, 10), ('a', 3, 30), ('c', 1, 50)",
];

const MERGED = [
  { itemId: "a", kind: "item", version: 3, since: 100 },
  { itemId: "a", kind: "queue", version: 3, since: 30 },
  { itemId: "b", kind: "item", version: 1, since: 200 },
  { itemId: "c", kind: "queue", version: 1, since: 50 },
];

describe("queue_wait merges into item_wait", () => {
  test("on Postgres", async () => {
    const pg = await pgliteDb({ migrationsFolder: before(PG_MIGRATIONS_FOLDER) });
    try {
      for (const id of ["a", "b", "c"]) await insertWorkItem(postgresDb(pg), id);
      for (const statement of OLD_ROWS) await pg.$client.exec(statement);
      await migratePg(pg, { migrationsFolder: PG_MIGRATIONS_FOLDER });
      const rows = await pg.$client.query<{ itemId: string; kind: string }>(
        'SELECT item_id AS "itemId", kind, version::int AS version, since::int AS since FROM item_wait ORDER BY item_id, kind',
      );
      expect(rows.rows).toEqual(MERGED);
      const old = await pg.$client.query("SELECT to_regclass('queue_wait') AS name");
      expect(old.rows).toEqual([{ name: null }]);
    } finally {
      await pg.$client.close();
    }
  });
});
