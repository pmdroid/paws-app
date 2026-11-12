import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { listTaskBlockers, saveTaskBlocks, type PgDb, type TaskBlock } from "../src/db";
import { tempStore } from "./pglite";

function edge(blockerLinearIssueId: string, blockedLinearIssueId: string): TaskBlock {
  return { blockerLinearIssueId, blockedLinearIssueId };
}

describe("task blocks", () => {
  test("saves and lists blockers sorted", async () => {
    const { db, close } = await tempStore();
    await saveTaskBlocks(
      db,
      ["a", "b"],
      [edge("m", "a"), edge("a-blocker", "a"), edge("a-blocker", "a"), edge("z", "b")],
    );
    expect(await listTaskBlockers(db, "a")).toEqual(["a-blocker", "m"]);
    expect(await listTaskBlockers(db, "b")).toEqual(["z"]);
    expect(await listTaskBlockers(db, "missing")).toEqual([]);
    await close();
  });

  test("saving again replaces the old blockers", async () => {
    const { db, close } = await tempStore();
    await saveTaskBlocks(db, ["a", "b"], [edge("x", "a"), edge("y", "a"), edge("z", "b")]);
    await saveTaskBlocks(db, ["a"], [edge("y", "a")]);
    expect(await listTaskBlockers(db, "a")).toEqual(["y"]);
    expect(await listTaskBlockers(db, "b")).toEqual(["z"]);
    await saveTaskBlocks(db, ["a"], []);
    expect(await listTaskBlockers(db, "a")).toEqual([]);
    expect(await listTaskBlockers(db, "b")).toEqual(["z"]);
    await close();
  });

  test("rejects an edge whose blocked issue is outside the set", async () => {
    const { db, close } = await tempStore();
    await saveTaskBlocks(db, ["a"], [edge("x", "a")]);
    await expect(saveTaskBlocks(db, ["a"], [edge("y", "a"), edge("z", "b")])).rejects.toThrow(
      Error,
    );
    expect(await listTaskBlockers(db, "a")).toEqual(["x"]);
    expect(await listTaskBlockers(db, "b")).toEqual([]);
    await close();
  });

  test("rejects a self block", async () => {
    const { db, close } = await tempStore();
    await saveTaskBlocks(db, ["a"], [edge("x", "a")]);
    await expect(saveTaskBlocks(db, ["a"], [edge("a", "a")])).rejects.toMatchObject({
      cause: { message: expect.stringContaining("violates check constraint") },
    });
    expect(await listTaskBlockers(db, "a")).toEqual(["x"]);
    await close();
  });

  test("work item has an owner column and no project start column", async () => {
    const { db, close } = await tempStore();
    const columns = (await (db as PgDb).orm.execute(
      sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'work_item'`,
    )) as unknown as { rows: { column_name: string }[] };
    const names = columns.rows.map((column) => column.column_name);
    expect(names).toContain("owner_user_id");
    expect(names).not.toContain("project_approval_id");
    const foreignKeys = (await (db as PgDb).orm.execute(
      sql`SELECT kcu.column_name AS "from", ccu.table_name AS "table", ccu.column_name AS "to"
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
          JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
          WHERE tc.table_name = 'work_item' AND tc.constraint_type = 'FOREIGN KEY'`,
    )) as unknown as { rows: { from: string; table: string; to: string }[] };
    expect(foreignKeys.rows).toContainEqual(
      expect.objectContaining({ from: "owner_user_id", table: "workspace_user", to: "id" }),
    );
    await close();
  });
});
