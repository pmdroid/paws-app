import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { migrate, migrations, openDatabase } from "../src/db";

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

function link(
  db: Database,
): { id: string; session_key: string | null; owner_user_id: string | null }[] {
  return db
    .query<{ id: string; session_key: string | null; owner_user_id: string | null }, []>(
      "SELECT id, session_key, owner_user_id FROM work_item ORDER BY id",
    )
    .all();
}

test("migration 060 backfills session_key and owner_user_id from the epic session", () => {
  const db = openDatabase(":memory:");
  try {
    applyMigrationsUntil(db, "059_drop_old_blocks");
    expect(
      db.query("SELECT 1 FROM schema_migration WHERE id = '060_session_link_on_item'").get(),
    ).toBeNull();
    db.run(
      "INSERT INTO workspace_user(id,linear_user_id,name,email) VALUES('user-owner','linear-owner','Owner','owner@example.invalid')",
    );
    db.run(
      "INSERT INTO workspace_user(id,linear_user_id,name,email) VALUES('user-fallback','linear-fallback','Fallback','fallback@example.invalid')",
    );
    db.run(
      "INSERT INTO workspace_user(id,linear_user_id,name,email) VALUES('user-preset','linear-preset','Preset','preset@example.invalid')",
    );
    for (const id of ["owned", "fallback", "ranked", "alone"]) {
      db.run(
        "INSERT INTO epic(id,linear_issue_id,linear_identifier,title,state,created_at) VALUES(?,?,?,?,?,?)",
        [id, id, id, id, "running", 1],
      );
    }
    db.run(
      "INSERT INTO linear_session(session_id,current_epic_id,created_at) VALUES('owned-session','owned',50)",
    );
    db.run("INSERT INTO linear_session(session_id,created_at) VALUES('fallback-session',10)");
    db.run(
      "INSERT INTO linear_session(session_id,current_epic_id,created_at) VALUES('rank-b','ranked',30)",
    );
    db.run(
      "INSERT INTO linear_session(session_id,current_epic_id,created_at) VALUES('rank-a','ranked',20)",
    );
    db.run(
      "INSERT INTO linear_session_task(session_id,epic_id,owner_actor_id) VALUES('owned-session','owned','linear-owner')",
    );
    db.run(
      "INSERT INTO linear_session_task(session_id,epic_id,owner_actor_id) VALUES('fallback-session','fallback','linear-fallback')",
    );
    db.run(
      "INSERT INTO work_item(id,epic_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at) VALUES('from-current','ranked','from-current','RC','Current','queued','paws/from-current',0,1)",
    );
    db.run(
      "INSERT INTO work_item(id,epic_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at) VALUES('from-task','fallback','from-task','FT','Task','queued','paws/from-task',0,1)",
    );
    db.run(
      "INSERT INTO work_item(id,epic_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at,owner_user_id) VALUES('keeps-owner','owned','keeps-owner','KO','Kept','queued','paws/keeps-owner',1,2,'user-preset')",
    );
    db.run(
      "INSERT INTO work_item(id,epic_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at,session_key) VALUES('keeps-session','owned','keeps-session','KS','Session','queued','paws/keeps-session',2,3,'already')",
    );
    db.run(
      "INSERT INTO work_item(id,epic_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at) VALUES('needs-link','owned','needs-link','NL','Link','queued','paws/needs-link',0,1)",
    );
    db.run(
      "INSERT INTO work_item(id,epic_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at) VALUES('untouched','alone','untouched','AL','Alone','queued','paws/untouched',0,1)",
    );
    expect(link(db).find((row) => row.id === "needs-link")).toEqual({
      id: "needs-link",
      session_key: null,
      owner_user_id: null,
    });
    migrate(db);
    expect(
      db.query("SELECT 1 FROM schema_migration WHERE id = '060_session_link_on_item'").get(),
    ).toBeTruthy();
    expect(link(db)).toEqual([
      { id: "from-current", session_key: "rank-a", owner_user_id: null },
      { id: "from-task", session_key: "fallback-session", owner_user_id: "user-fallback" },
      { id: "keeps-owner", session_key: "owned-session", owner_user_id: "user-preset" },
      { id: "keeps-session", session_key: "already", owner_user_id: null },
      { id: "needs-link", session_key: "owned-session", owner_user_id: "user-owner" },
      { id: "untouched", session_key: null, owner_user_id: null },
    ]);
  } finally {
    db.close();
  }
});
