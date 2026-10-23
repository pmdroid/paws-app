import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  applyLinearCommand,
  beginImplementRun,
  bindLinearSessionTask,
  delegatedLinearUserId,
  ensureLinearSession,
  insertQueuedItem,
  migrate,
  migrations,
  openDatabase,
} from "../src/db";
import { dispatch } from "../src/scheduler";
import { handleStatusRequest } from "../src/web";
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

test("migration 061 keeps the task actor that has no workspace user", () => {
  const db = openDatabase(":memory:");
  try {
    applyMigrationsUntil(db, "060_session_link_on_item");
    db.run(
      "INSERT INTO epic(id,linear_issue_id,linear_identifier,title,state,created_at) VALUES('epic','parent','DEP-1','Parent','running',1)",
    );
    db.run(
      "INSERT INTO work_item(id,epic_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at,session_key) VALUES('item','epic','issue','DEP-2','Item','queued','paws/item',0,1,'session')",
    );
    db.run(
      "INSERT INTO linear_session(session_id,creator_id,current_epic_id,created_at) VALUES('session','linear-creator','epic',1)",
    );
    db.run(
      "INSERT INTO linear_session_task(session_id,epic_id,owner_actor_id) VALUES('session','epic','linear-actor')",
    );
    migrate(db);
    expect(delegatedLinearUserId(db, "item")).toBe("linear-actor");
  } finally {
    db.close();
  }
});

test("binding a session keeps an actor that has no workspace user", () => {
  const db = tempDb();
  try {
    const item = insertQueuedItem(db, { id: "bound-item", sessionKey: "bound-session", now: 1 });
    ensureLinearSession(db, { sessionId: "bound-session", creatorId: "linear-creator", now: 1 });
    bindLinearSessionTask(db, "bound-session", item.delegationId, { actorId: "linear-actor" });
    expect(delegatedLinearUserId(db, item.id)).toBe("linear-actor");
  } finally {
    db.close();
  }
});

test("migration 061 drops the old session link table and columns", () => {
  const db = tempDb();
  try {
    expect(
      db.query("SELECT 1 FROM schema_migration WHERE id = '061_drop_old_session_link'").get(),
    ).toBeTruthy();
    expect(
      db
        .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'linear_session_task'")
        .get(),
    ).toBeNull();
    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(linear_session)")
      .all()
      .map((column) => column.name);
    expect(columns).not.toContain("current_epic_id");
    expect(columns).toContain("active_item_id");
  } finally {
    db.close();
  }
});

test("a stop command resolves the session through session_key alone", () => {
  const db = tempDb();
  try {
    const item = insertQueuedItem(db, { id: "stop-item", sessionKey: "stop-session", now: 1 });
    expect(
      applyLinearCommand(db, {
        type: "stop",
        source: "linear",
        itemId: item.id,
        requestedAt: 5,
      }).applied,
    ).toBe(true);
    expect(
      db
        .query<{ ordering_key: string }, []>("SELECT ordering_key FROM outbox")
        .all()
        .map((row) => row.ordering_key),
    ).toContain("stop-session");
  } finally {
    db.close();
  }
});

test("a transcript lookup resolves the session through session_key alone", async () => {
  const db = tempDb();
  try {
    const item = insertQueuedItem(db, {
      id: "transcript-item",
      sessionKey: "transcript-session",
      now: 1,
    });
    const { run } = beginImplementRun(db, item.id, 2);
    const response = await handleStatusRequest(
      new Request(`http://127.0.0.1/api/runs/transcript?run=${run.id}`, { method: "HEAD" }),
      { db, sessionIds: ["transcript-session"] },
    );
    expect(response?.status).toBe(200);
    const denied = await handleStatusRequest(
      new Request(`http://127.0.0.1/api/runs/transcript?run=${run.id}`, { method: "HEAD" }),
      { db, sessionIds: ["other-session"] },
    );
    expect(denied?.status).toBe(404);
  } finally {
    db.close();
  }
});

test("the scheduler resolves a session item through session_key alone", () => {
  const db = tempDb();
  try {
    const item = insertQueuedItem(db, { id: "sched-item", sessionKey: "sched-session", now: 1 });
    ensureLinearSession(db, { sessionId: "sched-session", issueId: item.linearIssueId, now: 1 });
    expect(dispatch(db, { now: 2, legacyReadyItemIds: [item.id] })).toEqual([item.id]);
    expect(
      db
        .query<{ session_id: string | null }, []>("SELECT session_id FROM scheduler_admission")
        .get()?.session_id,
    ).toBe("sched-session");
  } finally {
    db.close();
  }
});
