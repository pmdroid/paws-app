import { confirmFakeMerge } from "./fake-workspace";
import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  enqueueOutbox,
  listOutbox,
  listItemHolds,
  migrate,
  migrations,
  openDatabase,
  saveItemHolds,
} from "../src/db";
import { createAdmission, dispatch } from "../src/scheduler";
import { createLiveStatusProvider } from "../src/web";
import { workspaceAdmission, workspaceDispatch } from "./fake-workspace";
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
    expect(workspaceDispatch(db, { now: 1, log })).toEqual([]);
    expect(workspaceDispatch(db, { now: 2, log })).toEqual([]);
    expect(listItemHolds(db)).toEqual([
      { itemId: "PAS-368", reason: "blocked", blockers: ["PAS-367"] },
    ]);
    expect(lines).toEqual(["item PAS-368 held: blocked by PAS-367"]);
    db.run("UPDATE work_item SET state='merged' WHERE id='PAS-367'");
    expect(workspaceDispatch(db, { now: 3, log })).toEqual([]);
    expect(listItemHolds(db)).toEqual([
      { itemId: "PAS-368", reason: "blocked", blockers: ["PAS-367"] },
    ]);
    expect(
      createLiveStatusProvider(db)
        .snapshot()
        .items.find((entry) => entry.id === "PAS-368")?.blockers,
    ).toEqual(["PAS-367"]);
    confirmFakeMerge(db, "PAS-367");
    expect(workspaceDispatch(db, { now: 3, log })).toEqual(["PAS-368"]);
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
    workspaceDispatch(db, { now, log });
    expect(listItemHolds(db)).toEqual([{ itemId: "PAS-2", reason: "slot", blockers: [] }]);
    workspaceDispatch(db, { now: now + 1, log });
    db.run("DELETE FROM runner_work");
    workspaceDispatch(db, { now: now + 2, log, ownerCap: 1 });
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
    const admission = workspaceAdmission(db, { authority: () => false });
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
    expect(workspaceDispatch(db, { now: 1, log })).toEqual([]);
    confirmFakeMerge(db, "PAS-7");
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
    workspaceDispatch(db, { now: 1 });
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

function responses(db: Database) {
  return listOutbox(db).filter((row) => (row.payload as { kind?: string }).kind === "response");
}

test("hold responses survive scheduler restarts and follow blocker changes and slot waits", () => {
  const db = tempDb();
  try {
    item(db, "PAS-1", "running");
    item(db, "PAS-2", "running", 1);
    item(db, "PAS-3", "queued", 2);
    db.run(
      "INSERT INTO task_block VALUES('issue-PAS-1','issue-PAS-3'),('issue-PAS-2','issue-PAS-3')",
    );
    const sessionFor = () => "session-delegation";
    const tick = (now: number) => workspaceDispatch(db, { now, sessionFor });
    tick(1);
    expect(responses(db)).toHaveLength(1);
    expect(responses(db)[0]!.payload).toMatchObject({
      kind: "response",
      body: expect.stringContaining("PAS-1, PAS-2"),
    });
    tick(2);
    tick(60 * 60_000);
    expect(responses(db)).toHaveLength(1);
    confirmFakeMerge(db, "PAS-1");
    db.run("UPDATE work_item SET state='merged' WHERE id='PAS-1'");
    tick(3);
    expect(responses(db)).toHaveLength(2);
    expect(responses(db)[1]!.payload).toMatchObject({
      body: expect.stringContaining("blocked by PAS-2."),
    });
    fullRunner(db);
    confirmFakeMerge(db, "PAS-2");
    db.run("UPDATE work_item SET state='merged' WHERE id='PAS-2'");
    tick(Date.now());
    expect(responses(db)).toHaveLength(3);
    expect(responses(db)[2]!.payload).toMatchObject({
      body: "Queued: every runner slot you can use is busy. I'll start when one frees up.",
    });
    tick(Date.now() + 1);
    expect(responses(db)).toHaveLength(3);
    db.run("DELETE FROM runner_work");
    expect(tick(Date.now() + 2)).toEqual(["PAS-3"]);
    // The ordinary first activity must still be deliverable after a response in the same session.
    enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      orderingKey: sessionFor(),
      idempotencyKey: "started",
      payload: { kind: "thought", body: "Starting work." },
    });
    expect(listOutbox(db).at(-1)?.status).toBe("pending");
    expect(db.query("SELECT session_id FROM linear_session").all()).toEqual([
      { session_id: sessionFor() },
    ]);
  } finally {
    db.close();
  }
});

test("already held issues each receive one response on the first pass only", () => {
  const db = tempDb();
  try {
    item(db, "PAS-1", "running");
    for (const id of ["PAS-2", "PAS-3"]) {
      item(db, id);
      db.run("INSERT INTO task_block VALUES('issue-PAS-1',?)", [`issue-${id}`]);
    }
    saveItemHolds(
      db,
      ["PAS-2", "PAS-3"].map((itemId) => ({ itemId, reason: "blocked", blockers: ["PAS-1"] })),
    );
    workspaceDispatch(db, { now: 1, sessionFor: (id: string) => `session-${id}` });
    expect(responses(db)).toHaveLength(2);
    workspaceDispatch(db, { now: 2, sessionFor: (id: string) => `session-${id}` });
    expect(responses(db)).toHaveLength(2);
  } finally {
    db.close();
  }
});

test("owners without an eligible runner receive no busy-slot response", () => {
  const db = tempDb();
  try {
    item(db, "PAS-1");
    fullRunner(db);
    workspaceDispatch(db, {
      now: Date.now(),
      sessionFor: () => "session",
      ownerHasRunner: () => false,
    });
    expect(responses(db)).toEqual([]);
  } finally {
    db.close();
  }
});
