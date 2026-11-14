import { describe, expect, test } from "bun:test";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { migrate as migratePg } from "drizzle-orm/pglite/migrator";
import { getConversation, PG_MIGRATIONS_FOLDER, postgresDb, saveConversation } from "../src/db";
import { forEachDialect, insertWorkItem } from "./dialects";
import { tempHome } from "./helpers";
import { pgliteDb } from "./pglite";

const TAG = "linear_conversation_entry";

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

const HISTORY = [
  { kind: "request", body: "first request" },
  { kind: "response", body: 'said "done"' },
  { kind: "tool_result", body: "wrote result.txt" },
];

const OLD_ROWS = (entries: (value: unknown) => string) => [
  `INSERT INTO linear_conversation (item_id, entries, transcript, blocked) VALUES ('a', ${entries(HISTORY)}, NULL, 0), ('b', ${entries([])}, NULL, 1)`,
];

describe("linear_conversation entries move into linear_conversation_entry", () => {
  test("on Postgres", async () => {
    const pg = await pgliteDb({ migrationsFolder: before(PG_MIGRATIONS_FOLDER) });
    try {
      const db = postgresDb(pg);
      for (const id of ["a", "b"]) await insertWorkItem(db, id);
      const jsonb = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
      for (const statement of OLD_ROWS(jsonb)) await pg.$client.exec(statement);
      await migratePg(pg, { migrationsFolder: PG_MIGRATIONS_FOLDER });
      expect(JSON.parse((await getConversation(db, "a")).entries)).toEqual(HISTORY);
      expect(await getConversation(db, "b")).toMatchObject({ entries: "[]", blocked: true });
      const column = await pg.$client.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'linear_conversation' AND column_name = 'entries'",
      );
      expect(column.rows).toEqual([]);
    } finally {
      await pg.$client.close();
    }
  });
});

forEachDialect((open) => {
  test("appending and reading return the same entries in the same order", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "item");
      expect((await getConversation(db, "item")).entries).toBe("[]");
      for (let length = 1; length <= HISTORY.length; length++) {
        await saveConversation(db, "item", JSON.stringify(HISTORY.slice(0, length)), null);
        expect(JSON.parse((await getConversation(db, "item")).entries)).toEqual(
          HISTORY.slice(0, length),
        );
      }
      await saveConversation(db, "item", JSON.stringify(HISTORY), "/run/acp.jsonl", false, 7);
      expect(await getConversation(db, "item")).toMatchObject({
        transcript: "/run/acp.jsonl",
        transcriptOffset: 7,
      });
      expect(JSON.parse((await getConversation(db, "item")).entries)).toEqual(HISTORY);
      const edited = [HISTORY[0], { kind: "response", body: "said something else" }, HISTORY[2]];
      await saveConversation(db, "item", JSON.stringify(edited), null);
      expect(JSON.parse((await getConversation(db, "item")).entries)).toEqual(edited);
      await saveConversation(db, "item", JSON.stringify(HISTORY.slice(0, 1)), null);
      expect(JSON.parse((await getConversation(db, "item")).entries)).toEqual(HISTORY.slice(0, 1));
    } finally {
      await close();
    }
  });
});

test("appending one entry writes one row", async () => {
  const pg = await pgliteDb();
  try {
    const db = postgresDb(pg);
    await insertWorkItem(db, "item");
    await saveConversation(db, "item", JSON.stringify(HISTORY.slice(0, 2)), null);
    await pg.$client.exec(`
      CREATE TABLE entry_write (op text NOT NULL);
      CREATE FUNCTION count_entry_write() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO entry_write VALUES (TG_OP); RETURN NULL; END $$;
      CREATE TRIGGER count_entry_write AFTER INSERT OR UPDATE OR DELETE ON linear_conversation_entry
        FOR EACH ROW EXECUTE FUNCTION count_entry_write();
    `);
    await saveConversation(db, "item", JSON.stringify(HISTORY), null);
    const writes = await pg.$client.query("SELECT op FROM entry_write");
    expect(writes.rows).toEqual([{ op: "INSERT" }]);
    expect(JSON.parse((await getConversation(db, "item")).entries)).toEqual(HISTORY);
  } finally {
    await pg.$client.close();
  }
});
