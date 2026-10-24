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

  test("migration 058 keeps the newer active item and rejects a second", () => {
    const db = openDatabase(":memory:");
    db.run(
      "CREATE TABLE schema_migration (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT",
    );
    for (const migration of migrations) {
      if (
        migration.id === "058_one_active_item" ||
        migration.id === "059_drop_old_blocks" ||
        migration.id === "064_work_item_without_epic_fk" ||
        migration.id === "065_drop_epic" ||
        // Copies project_approval_issue.delegation_id, which 065 renames from epic_id.
        migration.id === "129_parent_delegation" ||
        // Rebuilds work_item with delegation_id, which 065 adds.
        migration.id === "130_drop_project_start"
      )
        continue;
      if (migration.foreignKeys === false) db.run("PRAGMA foreign_keys = OFF");
      db.transaction(() => {
        db.run(migration.sql);
        db.run("INSERT INTO schema_migration (id, applied_at) VALUES (?, ?)", [migration.id, 0]);
      }).immediate();
      if (migration.foreignKeys === false) db.run("PRAGMA foreign_keys = ON");
    }
    const insertLegacyQueued = (id: string, now: number) => {
      const delegationId = `epic-${id}`;
      db.run(
        `INSERT INTO epic (id, linear_issue_id, linear_identifier, title, state, created_at)
         VALUES (?, ?, ?, 'Work item', 'running', ?)`,
        [delegationId, `lin-${id}`, id, now],
      );
      db.run(
        `INSERT INTO work_item (
           id, epic_id, linear_issue_id, linear_identifier, title, state, branch_name, position, created_at, session_key
         ) VALUES (?, ?, ?, ?, 'Work item', 'queued', ?, 0, ?, 'session')`,
        [id, delegationId, `lin-item-${id}`, id, `paws/${id}`, now],
      );
      return delegationId;
    };
    const retiredEpic = insertLegacyQueued("m-older", 1);
    const survivingEpic = insertLegacyQueued("a-newer", 2);
    db.run("UPDATE work_item SET linear_issue_id = ? WHERE id = ?", ["shared-issue", "m-older"]);
    db.run("UPDATE work_item SET linear_issue_id = ?, state = 'running' WHERE id = ?", [
      "shared-issue",
      "a-newer",
    ]);
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
    migrate(db, { until: "129_parent_delegation" });
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

  test("work item has an owner column and no project start column", () => {
    const db = tempDb();
    const names = db
      .query<{ name: string }, []>("PRAGMA table_info(work_item)")
      .all()
      .map((column) => column.name);
    expect(names).toContain("owner_user_id");
    expect(names).not.toContain("project_approval_id");
    const foreignKeys = db
      .query<{ from: string; table: string; to: string }, []>("PRAGMA foreign_key_list(work_item)")
      .all();
    expect(foreignKeys).toContainEqual(
      expect.objectContaining({ from: "owner_user_id", table: "workspace_user", to: "id" }),
    );
    db.close();
  });
});
