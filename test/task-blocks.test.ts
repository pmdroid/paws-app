import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  enqueueJob,
  getWorkItem,
  insertQueuedItem,
  listTaskBlockers,
  migrate,
  migrations,
  openDatabase,
  saveTaskBlocks,
  type TaskBlock,
} from "../src/db";
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

  test("migration 058 keeps the newer active item and rejects a second", () => {
    const db = openDatabase(":memory:");
    db.run(
      "CREATE TABLE schema_migration (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT",
    );
    for (const migration of migrations) {
      if (migration.id === "058_one_active_item") continue;
      if (migration.foreignKeys === false) db.run("PRAGMA foreign_keys = OFF");
      db.transaction(() => {
        db.run(migration.sql);
        db.run("INSERT INTO schema_migration (id, applied_at) VALUES (?, ?)", [migration.id, 0]);
      }).immediate();
      if (migration.foreignKeys === false) db.run("PRAGMA foreign_keys = ON");
    }
    insertQueuedItem(db, { id: "m-older", now: 1 });
    insertQueuedItem(db, { id: "a-newer", now: 2 });
    db.run("UPDATE work_item SET linear_issue_id = ? WHERE id = ?", ["shared-issue", "m-older"]);
    db.run("UPDATE work_item SET linear_issue_id = ?, state = 'running' WHERE id = ?", [
      "shared-issue",
      "a-newer",
    ]);
    const retiredEpic = getWorkItem(db, "m-older")!.epicId;
    const survivingEpic = getWorkItem(db, "a-newer")!.epicId;
    db.run(
      "INSERT INTO work_item_block(epic_id,blocker_linear_issue_id,blocked_linear_issue_id) VALUES(?,?,?)",
      [survivingEpic, "inside-blocker", "shared-issue"],
    );
    db.run(
      "INSERT INTO external_dep(epic_id,blocker_linear_issue_id,blocked_linear_issue_id) VALUES(?,?,?)",
      [survivingEpic, "outside-blocker", "shared-issue"],
    );
    db.run(
      "INSERT INTO external_dep(epic_id,blocker_linear_issue_id,blocked_linear_issue_id) VALUES(?,?,?)",
      [retiredEpic, "stale-blocker", "shared-issue"],
    );
    db.run(
      "INSERT INTO run(id,item_id,kind,agent,status,created_at,updated_at) VALUES('older-run','m-older','work','claude','active',1,1)",
    );
    const job = enqueueJob(db, { queue: "item.start", payload: { itemId: "m-older" }, now: 1 });
    migrate(db);
    expect(listTaskBlockers(db, "shared-issue")).toEqual(["inside-blocker", "outside-blocker"]);
    expect(
      db.query<{ status: string }, []>("SELECT status FROM run WHERE id='older-run'").get()?.status,
    ).toBe("ended");
    expect(
      db.query<{ status: string }, [number]>("SELECT status FROM job WHERE id=?").get(job)?.status,
    ).toBe("cancelled");
    expect(getWorkItem(db, "m-older")?.cancelRequested).toBe(true);
    expect(getWorkItem(db, "m-older")?.state).toBe("cancelled");
    expect(getWorkItem(db, "a-newer")?.state).toBe("running");
    expect(
      db.query("SELECT 1 FROM schema_migration WHERE id = '058_one_active_item'").get(),
    ).toBeTruthy();
    expect(
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE name = 'work_item_active_issue'",
        )
        .get()?.name,
    ).toBe("work_item_active_issue");
    const extra = insertQueuedItem(db, { id: "extra", now: 3 });
    expect(() =>
      db.run("UPDATE work_item SET linear_issue_id = ? WHERE id = ?", ["shared-issue", extra.id]),
    ).toThrow(/UNIQUE/);
    const done = insertQueuedItem(db, { id: "done", now: 4 });
    db.run("UPDATE work_item SET state = 'merged' WHERE id = ?", [done.id]);
    db.run("UPDATE work_item SET linear_issue_id = ? WHERE id = ?", ["shared-issue", done.id]);
    expect(getWorkItem(db, "done")).toMatchObject({
      state: "merged",
      linearIssueId: "shared-issue",
    });
    expect(getWorkItem(db, "a-newer")?.state).toBe("running");
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
