import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDatabase } from "../src/db";
import { migrateDryRun } from "../scripts/migrate-dry-run";

const dropped = [
  "project_approval",
  "project_approval_issue",
  "project_approval_member",
  "item_blocker_policy",
] as const;

function tables(db: Database): string[] {
  return db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((row) => row.name);
}

function columns(db: Database, table: string): string[] {
  return db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => row.name);
}

function applied(db: Database): boolean {
  return (
    db.query("SELECT 1 FROM schema_migration WHERE id='130_drop_project_start'").get() !== null
  );
}

/** A database just before 130 with one project start and the given project items. */
function beforeDrop(
  items: ReadonlyArray<readonly [id: string, state: string]>,
  path = ":memory:",
): Database {
  const db = openDatabase(path);
  migrate(db, { until: "129_parent_delegation" });
  db.run(
    "INSERT INTO workspace(id,linear_organization_id,name,created_at) VALUES('ws','org','Workspace',0)",
  );
  db.run(
    "INSERT INTO workspace_user(id,linear_user_id,name,email) VALUES('ada','linear-ada','Ada','ada@example.test')",
  );
  db.run(
    `INSERT INTO project_approval(id,workspace_id,project_id,actor_id,lead_user_id,generation,preview,created_at,expires_at,approved_at)
     VALUES('launch','ws','project','ada','ada','1','{}',0,9000,0)`,
  );
  db.run("INSERT INTO project_approval_member(approval_id,linear_user_id) VALUES('launch','ben')");
  const insert = (id: string, state: string, approval: string | null, position: number) =>
    db.run(
      `INSERT INTO work_item(id,delegation_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at,owner_user_id,project_approval_id,linear_project_id,linear_project_name)
       VALUES(?,?,?,?,'Task',?,?,?,?,'ada',?,'linear-project','Runtimes')`,
      [
        id,
        `del-${id}`,
        `lin-${id}`,
        id.toUpperCase(),
        state,
        `paws/${id}`,
        position,
        position,
        approval,
      ],
    );
  items.forEach(([id, state], position) => {
    insert(id, state, "launch", position);
    db.run(
      "INSERT INTO project_approval_issue(workspace_id,issue_id,approval_id,delegation_id) VALUES('ws',?,'launch',?)",
      [`lin-${id}`, `del-${id}`],
    );
  });
  insert("solo", "running", null, items.length);
  db.run(
    `INSERT INTO item_blocker_policy(workspace_id,item_id,blocker_issue_id,policy,user_id,revision)
     VALUES('ws','solo','blocker','{"blockerLinearIssueId":"blocker","outcome":"completion"}','ada',1)`,
  );
  return db;
}

test("a database whose only project items are finished drops the project start", () => {
  const db = beforeDrop([
    ["merged", "merged"],
    ["done", "completed"],
    ["cancelled", "cancelled"],
  ]);
  try {
    const before = db
      .query(
        "SELECT id,delegation_id,state,owner_user_id,linear_project_name FROM work_item ORDER BY id",
      )
      .all();
    migrate(db);
    expect(applied(db)).toBe(true);
    for (const name of dropped) expect(tables(db), name).not.toContain(name);
    expect(columns(db, "work_item")).not.toContain("project_approval_id");
    expect(
      db
        .query(
          "SELECT id,delegation_id,state,owner_user_id,linear_project_name FROM work_item ORDER BY id",
        )
        .all(),
    ).toEqual(before);
    for (const index of ["work_item_active_issue", "work_item_delegation_position"])
      expect(db.query("SELECT 1 FROM sqlite_master WHERE name=?").get(index), index).not.toBeNull();
    expect(
      db.query("SELECT 1 FROM sqlite_master WHERE name='work_item_project_approval'").get(),
    ).toBeNull();
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys).toBe(
      1,
    );
  } finally {
    db.close();
  }
});

test("an active project item stops the migration with its id until it is cancelled", () => {
  const db = beforeDrop([
    ["merged", "merged"],
    ["active", "awaiting_input"],
  ]);
  try {
    expect(() => migrate(db)).toThrow(/Work item active \(ACTIVE, awaiting_input\)/);
    expect(applied(db)).toBe(false);
    for (const name of dropped) expect(tables(db), name).toContain(name);
    expect(columns(db, "work_item")).toContain("project_approval_id");
    expect(db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys).toBe(
      1,
    );

    db.run("UPDATE work_item SET state='cancelled' WHERE id='active'");
    migrate(db);
    expect(applied(db)).toBe(true);
    expect(tables(db)).not.toContain("project_approval");
  } finally {
    db.close();
  }
});

test("a dry run migrates a copy and leaves the original database as it was", () => {
  const dir = mkdtempSync(join(tmpdir(), "paws-dry-run-"));
  const path = join(dir, "paws.db");
  try {
    beforeDrop([["done", "merged"]], path).close();
    expect(migrateDryRun(path).applied).toEqual(["130_drop_project_start"]);
    const db = openDatabase(path);
    try {
      expect(applied(db)).toBe(false);
      expect(tables(db)).toContain("project_approval");
      db.run("UPDATE work_item SET state='running' WHERE id='done'");
    } finally {
      db.close();
    }
    expect(() => migrateDryRun(path)).toThrow(/Work item done/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
