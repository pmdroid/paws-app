import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { listTaskBlockers, saveTaskBlocks, type TaskBlock } from "../src/db";
import { tempDb } from "./helpers";

function edge(blockerLinearIssueId: string, blockedLinearIssueId: string): TaskBlock {
  return { blockerLinearIssueId, blockedLinearIssueId };
}

function insertApproval(db: Database, id: string, generation: string, source?: string): void {
  const values = [id, "ws", "project", "user", "user", generation, "{}", 0, 1];
  if (source === undefined) {
    db.run(
      `INSERT INTO project_approval(id,workspace_id,project_id,actor_id,lead_user_id,generation,preview,created_at,expires_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      values,
    );
    return;
  }
  db.run(
    `INSERT INTO project_approval(id,workspace_id,project_id,actor_id,lead_user_id,generation,preview,created_at,expires_at,source)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
    [...values, source],
  );
}

describe("task blocks", () => {
  test("saves and lists blockers sorted", () => {
    const db = tempDb();
    saveTaskBlocks(
      db,
      ["a", "b"],
      [edge("m", "a"), edge("a-blocker", "a"), edge("a-blocker", "a"), edge("z", "b")],
    );
    expect(listTaskBlockers(db, "a")).toEqual(["a-blocker", "m"]);
    expect(listTaskBlockers(db, "b")).toEqual(["z"]);
    expect(listTaskBlockers(db, "missing")).toEqual([]);
    db.close();
  });

  test("saving again replaces the old blockers", () => {
    const db = tempDb();
    saveTaskBlocks(db, ["a", "b"], [edge("x", "a"), edge("y", "a"), edge("z", "b")]);
    saveTaskBlocks(db, ["a"], [edge("y", "a")]);
    expect(listTaskBlockers(db, "a")).toEqual(["y"]);
    expect(listTaskBlockers(db, "b")).toEqual(["z"]);
    saveTaskBlocks(db, ["a"], []);
    expect(listTaskBlockers(db, "a")).toEqual([]);
    expect(listTaskBlockers(db, "b")).toEqual(["z"]);
    db.close();
  });

  test("rejects an edge whose blocked issue is outside the set", () => {
    const db = tempDb();
    saveTaskBlocks(db, ["a"], [edge("x", "a")]);
    expect(() => saveTaskBlocks(db, ["a"], [edge("y", "a"), edge("z", "b")])).toThrow(Error);
    expect(listTaskBlockers(db, "a")).toEqual(["x"]);
    expect(listTaskBlockers(db, "b")).toEqual([]);
    db.close();
  });

  test("rejects a self block", () => {
    const db = tempDb();
    saveTaskBlocks(db, ["a"], [edge("x", "a")]);
    expect(() => saveTaskBlocks(db, ["a"], [edge("a", "a")])).toThrow(/CHECK/);
    expect(listTaskBlockers(db, "a")).toEqual(["x"]);
    db.close();
  });

  test("project approval source defaults to project and rejects other values", () => {
    const db = tempDb();
    db.run(
      "INSERT INTO workspace(id,linear_organization_id,name,created_at) VALUES('ws','org','Workspace',0)",
    );
    db.run(
      "INSERT INTO workspace_user(id,linear_user_id,name,email) VALUES('user','linear-user','User','user@example.test')",
    );
    insertApproval(db, "default", "1");
    insertApproval(db, "parent", "2", "parent");
    expect(
      db
        .query<{ source: string }, [string]>("SELECT source FROM project_approval WHERE id=?")
        .get("default")?.source,
    ).toBe("project");
    expect(
      db
        .query<{ source: string }, [string]>("SELECT source FROM project_approval WHERE id=?")
        .get("parent")?.source,
    ).toBe("parent");
    expect(() => insertApproval(db, "other", "3", "epic")).toThrow(/CHECK/);
    db.close();
  });

  test("work item has owner and project columns", () => {
    const db = tempDb();
    const names = db
      .query<{ name: string }, []>("PRAGMA table_info(work_item)")
      .all()
      .map((column) => column.name);
    expect(names).toContain("owner_user_id");
    expect(names).toContain("project_approval_id");
    const foreignKeys = db
      .query<{ from: string; table: string; to: string }, []>("PRAGMA foreign_key_list(work_item)")
      .all();
    expect(foreignKeys).toContainEqual(
      expect.objectContaining({ from: "owner_user_id", table: "workspace_user", to: "id" }),
    );
    expect(foreignKeys).toContainEqual(
      expect.objectContaining({
        from: "project_approval_id",
        table: "project_approval",
        to: "id",
      }),
    );
    db.close();
  });
});
