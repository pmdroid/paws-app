import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { insertQueuedItem, migrate, migrations, openDatabase } from "../src/db";
import { epicSnapshotsComplete } from "../src/intake";
import { tempDb } from "./helpers";

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

test("migration 062 starts items without a snapshot so startup resyncs them", () => {
  const db = openDatabase(":memory:");
  try {
    applyMigrationsUntil(db, "060_session_link_on_item");
    expect(
      db.query("SELECT 1 FROM schema_migration WHERE id = '062_item_dependency_snapshot'").get(),
    ).toBeNull();
    db.run(
      "INSERT INTO workspace(id,linear_organization_id,name,created_at) VALUES('workspace','org','Workspace',1)",
    );
    db.run(
      "INSERT INTO epic(id,linear_issue_id,linear_identifier,title,state,created_at) VALUES('epic','parent','DEP','Parent','running',1)",
    );
    db.run(
      "INSERT INTO epic_dependency_snapshot(epic_id,workspace_id,generation,scope,linear_states,external_evidence) VALUES('epic','workspace',4,'{\"kept\":true}','[[\"out\",\"completed\"]]','{\"out\":{\"satisfied\":true}}')",
    );
    for (const [id, state, position] of [
      ["queued-item", "queued", 0],
      ["running-item", "running", 1],
      ["merged-item", "merged", 2],
    ] as const)
      db.run(
        "INSERT INTO work_item(id,epic_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at) VALUES(?,?,?,?,?,?,?,?,1)",
        [id, "epic", id, id, id, state, `paws/${id}`, position],
      );
    migrate(db);
    expect(db.query("SELECT item_id FROM item_dependency_snapshot").all()).toEqual([]);
    expect(
      db.query("SELECT 1 FROM epic_dependency_snapshot WHERE epic_id='epic'").get(),
    ).toBeTruthy();
  } finally {
    db.close();
  }
});

test("an epic is snapshot-ready only when every active item has a snapshot", () => {
  const db = tempDb();
  try {
    const first = insertQueuedItem(db, { id: "first", now: 1 });
    db.run(
      "INSERT INTO work_item(id,epic_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at) VALUES('second',?,'second','DEP-3','Second','queued','paws/second',1,1)",
      [first.epicId],
    );
    db.run(
      "INSERT INTO work_item(id,epic_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at) VALUES('done',?,'done','DEP-4','Done','merged','paws/done',2,1)",
      [first.epicId],
    );
    db.run(
      "INSERT INTO workspace(id,linear_organization_id,name,created_at) VALUES('workspace','org','Workspace',1)",
    );
    const snap = (itemId: string) =>
      db.run(
        "INSERT INTO item_dependency_snapshot(item_id,workspace_id,generation,scope,linear_states) VALUES(?,'workspace',1,'[]','[]')",
        [itemId],
      );
    expect(epicSnapshotsComplete(db, first.epicId)).toBe(false);
    snap("first");
    expect(epicSnapshotsComplete(db, first.epicId)).toBe(false);
    snap("second");
    expect(epicSnapshotsComplete(db, first.epicId)).toBe(true);
    db.run(
      "INSERT INTO work_item(id,epic_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at) VALUES('removed',?,'removed','DEP-5','Removed','queued','paws/removed',3,1)",
      [first.epicId],
    );
    db.run(
      "INSERT INTO work_item_specification(item_id,hash,revision,present) VALUES('removed','hash',1,0)",
    );
    expect(epicSnapshotsComplete(db, first.epicId)).toBe(true);
  } finally {
    db.close();
  }
});
