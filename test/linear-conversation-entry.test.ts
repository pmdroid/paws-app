import { expect, test } from "bun:test";
import { getConversation, postgresDb, saveConversation } from "../src/db";
import { describePglite, insertWorkItem } from "./pglite-fixtures";
import { pgliteDb } from "./pglite";

const HISTORY = [
  { kind: "request", body: "first request" },
  { kind: "response", body: 'said "done"' },
  { kind: "tool_result", body: "wrote result.txt" },
];

describePglite((open) => {
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
