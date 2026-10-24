import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { listItemHolds, migrate, migrations, openDatabase, saveItemHolds } from "../src/db";
import { createAdmission, dispatch } from "../src/scheduler";
import { createLiveStatusProvider } from "../src/web";
import { tempDb } from "./helpers";

function item(db: Database, id: string, state = "queued", position = 0) {
  db.run(
    `INSERT INTO work_item(id,delegation_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    [id, "delegation", `issue-${id}`, id, id, state, `paws/${id}`, position, position],
  );
}

function fullRunner(db: Database) {
  db.run("PRAGMA foreign_keys=OFF");
  db.run(
    "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES('runner','ws','owner','Runner','active',0,?)",
    [Date.now()],
  );
  db.run(
    "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until,last_sequence) VALUES('run','runner','ws',1,0,'command',?,0)",
    [Date.now() + 600_000],
  );
}

function journal() {
  const lines: string[] = [];
  return { lines, log: (line: string) => lines.push(line) };
}

test("a blocked item names its blocker once in the journal and once more when it starts", () => {
  const db = tempDb();
  try {
    item(db, "PAS-367", "running");
    item(db, "PAS-368", "queued", 1);
    db.run("INSERT INTO task_block VALUES('issue-PAS-367','issue-PAS-368')");
    const { lines, log } = journal();
    expect(dispatch(db, { now: 1, log })).toEqual([]);
    expect(dispatch(db, { now: 2, log })).toEqual([]);
    expect(listItemHolds(db)).toEqual([
      { itemId: "PAS-368", reason: "blocked", blockers: ["PAS-367"] },
    ]);
    expect(lines).toEqual(["item PAS-368 held: blocked by PAS-367"]);
    db.run("UPDATE work_item SET state='merged' WHERE id='PAS-367'");
    expect(dispatch(db, { now: 3, log })).toEqual(["PAS-368"]);
    expect(listItemHolds(db)).toEqual([]);
    expect(lines).toEqual(["item PAS-368 held: blocked by PAS-367", "item PAS-368 no longer held"]);
  } finally {
    db.close();
  }
});

test("a ready item without a free slot, then over its owner cap, journals each new reason", () => {
  const db = tempDb();
  try {
    item(db, "PAS-1", "running");
    item(db, "PAS-2", "queued", 1);
    const { lines, log } = journal();
    fullRunner(db);
    const now = Date.now();
    dispatch(db, { now, log });
    expect(listItemHolds(db)).toEqual([{ itemId: "PAS-2", reason: "slot", blockers: [] }]);
    dispatch(db, { now: now + 1, log });
    db.run("DELETE FROM runner_work");
    dispatch(db, { now: now + 2, log, ownerCap: 1 });
    expect(listItemHolds(db)).toEqual([{ itemId: "PAS-2", reason: "cap", blockers: [] }]);
    expect(lines).toEqual([
      "item PAS-2 held: no free slot on any runner",
      "item PAS-2 held: its owner already runs the most tasks at once",
    ]);
  } finally {
    db.close();
  }
});

test("a project that holds an item is its held reason", () => {
  const db = tempDb();
  try {
    item(db, "PAS-5");
    const { lines, log } = journal();
    const admission = createAdmission({ db, authority: () => false });
    expect(dispatch(db, { now: 1, log, admission })).toEqual([]);
    expect(listItemHolds(db)).toEqual([{ itemId: "PAS-5", reason: "project", blockers: [] }]);
    expect(lines).toEqual(["item PAS-5 held: its project has not released it yet"]);
  } finally {
    db.close();
  }
});

test("without a workspace every queued item is held for the workspace, journaled once", () => {
  const db = tempDb();
  try {
    item(db, "PAS-7", "running");
    item(db, "PAS-8", "queued", 1);
    db.run("INSERT INTO task_block VALUES('issue-PAS-7','issue-PAS-8')");
    const { lines, log } = journal();
    expect(dispatch(db, { now: 1, log })).toEqual([]);
    db.run("UPDATE work_item SET state='merged' WHERE id='PAS-7'");
    item(db, "PAS-9", "queued", 2);
    const admission = createAdmission({ db, workspace: false });
    expect(dispatch(db, { now: 2, log, admission })).toEqual([]);
    expect(dispatch(db, { now: 3, log, admission })).toEqual([]);
    expect(listItemHolds(db)).toEqual([
      { itemId: "PAS-8", reason: "workspace", blockers: [] },
      { itemId: "PAS-9", reason: "workspace", blockers: [] },
    ]);
    expect(lines).toEqual([
      "item PAS-8 held: blocked by PAS-7",
      "item PAS-8 held: no Linear workspace",
      "item PAS-9 held: no Linear workspace",
    ]);
    expect(
      createLiveStatusProvider(db)
        .snapshot()
        .items.find((entry) => entry.id === "PAS-9")?.held,
    ).toEqual({ reason: "workspace", blockers: [] });
  } finally {
    db.close();
  }
});

test("the status API carries the held reason of a queued item", () => {
  const db = tempDb();
  try {
    item(db, "PAS-367", "running");
    item(db, "PAS-368", "queued", 1);
    db.run("INSERT INTO task_block VALUES('issue-PAS-367','issue-PAS-368')");
    dispatch(db, { now: 1 });
    const items = createLiveStatusProvider(db).snapshot().items;
    expect(items.find((entry) => entry.id === "PAS-368")?.held).toEqual({
      reason: "blocked",
      blockers: ["PAS-367"],
    });
    expect(items.find((entry) => entry.id === "PAS-367")?.held).toBeUndefined();
  } finally {
    db.close();
  }
});

test("migration 124 keeps the stored holds and accepts the workspace reason", () => {
  const db = openDatabase(":memory:");
  try {
    db.run(
      "CREATE TABLE schema_migration (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT",
    );
    const cutoff = migrations.findIndex((migration) => migration.id === "124_item_hold_workspace");
    expect(cutoff).toBeGreaterThan(0);
    for (const migration of migrations.slice(0, cutoff)) {
      db.run(migration.sql);
      db.run("INSERT INTO schema_migration (id, applied_at) VALUES (?, 0)", [migration.id]);
    }
    item(db, "PAS-8");
    item(db, "PAS-9");
    db.run("INSERT INTO item_hold VALUES('PAS-8','blocked','[\"PAS-7\"]')");
    migrate(db);
    saveItemHolds(db, [
      { itemId: "PAS-8", reason: "blocked", blockers: ["PAS-7"] },
      { itemId: "PAS-9", reason: "workspace", blockers: [] },
    ]);
    expect(listItemHolds(db)).toEqual([
      { itemId: "PAS-8", reason: "blocked", blockers: ["PAS-7"] },
      { itemId: "PAS-9", reason: "workspace", blockers: [] },
    ]);
  } finally {
    db.close();
  }
});
