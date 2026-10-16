import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { migrate, migrations, openDatabase } from "../src/db";
import { tempDb } from "./helpers";

const droppedTables = [
  "epic_dependency_snapshot",
  "epic_reconciliation_request",
  "epic_reconciliation_effect",
  "external_blocker_policy",
  "epic",
] as const;

function applyMigrationsUntil(db: Database, lastId: string): void {
  db.run(
    "CREATE TABLE IF NOT EXISTS schema_migration (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT",
  );
  const cutoff = migrations.findIndex((migration) => migration.id === lastId);
  if (cutoff < 0) throw new Error(`missing migration ${lastId}`);
  for (const migration of migrations.slice(0, cutoff + 1)) {
    const foreignKeys =
      db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys ?? 1;
    if (migration.foreignKeys === false) db.run("PRAGMA foreign_keys = OFF");
    try {
      const apply = db.transaction(() => {
        db.run(migration.sql);
        if (
          migration.foreignKeys === false &&
          db.query("PRAGMA foreign_key_check").all().length > 0
        )
          throw new Error("Identity migration would break foreign keys");
        db.run("INSERT INTO schema_migration (id, applied_at) VALUES (?, ?)", [migration.id, 0]);
      });
      apply.immediate();
    } finally {
      if (migration.foreignKeys === false)
        db.run(`PRAGMA foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
    }
  }
}

function tableNames(db: Database): string[] {
  return db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
}

function columnNames(db: Database, table: string): string[] {
  return db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .map((column) => column.name);
}

test("migration 065 keeps every work item row and its delegation id", () => {
  const db = openDatabase(":memory:");
  try {
    applyMigrationsUntil(db, "064_work_item_without_epic_fk");
    for (const name of droppedTables) expect(tableNames(db).includes(name), name).toBe(true);
    db.run(
      "INSERT INTO work_item(id,epic_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at) VALUES('kept','del-kept','issue-kept','KEEP','Kept','queued','paws/kept',0,1)",
    );
    db.run(
      "INSERT INTO work_item(id,epic_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at) VALUES('other','del-other','issue-other','OTHER','Other','merged','paws/other',1,2)",
    );
    const before = db
      .query<{ id: string; delegationId: string }, []>(
        "SELECT id, epic_id AS delegationId FROM work_item ORDER BY id",
      )
      .all();
    migrate(db);
    expect(
      db.query("SELECT 1 FROM schema_migration WHERE id = '065_drop_epic'").get(),
    ).toBeTruthy();
    expect(columnNames(db, "work_item")).toContain("delegation_id");
    expect(columnNames(db, "work_item")).not.toContain("epic_id");
    expect(columnNames(db, "project_approval_issue")).toContain("delegation_id");
    expect(columnNames(db, "project_approval_issue")).not.toContain("epic_id");
    expect(
      db.query("SELECT 1 FROM sqlite_master WHERE name = 'work_item_delegation_position'").get(),
    ).toBeTruthy();
    expect(
      db.query("SELECT 1 FROM sqlite_master WHERE name = 'work_item_epic_position'").get(),
    ).toBeNull();
    for (const name of droppedTables) expect(tableNames(db).includes(name), name).toBe(false);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      db
        .query<{ id: string; delegationId: string }, []>(
          "SELECT id, delegation_id AS delegationId FROM work_item ORDER BY id",
        )
        .all(),
    ).toEqual(before);
  } finally {
    db.close();
  }
});

test("inserting a work item needs no epic row", () => {
  const db = tempDb();
  try {
    expect(tableNames(db).includes("epic")).toBe(false);
    db.run(
      "INSERT INTO work_item(id,delegation_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at) VALUES('solo','del-solo','issue-solo','SOLO','Solo','queued','paws/solo',0,1)",
    );
    expect(
      db
        .query<{ delegationId: string }, []>("SELECT delegation_id AS delegationId FROM work_item")
        .all(),
    ).toEqual([{ delegationId: "del-solo" }]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
  }
});
