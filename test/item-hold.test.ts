import { confirmFakeMerge } from "./fake-workspace";
import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { setJournalSink } from "../src/journal";
import {
  listItemHolds,
  legacyMigrate,
  migrations,
  openDatabase,
  sqliteDb,
  syncSteps,
} from "../src/db";
import { recordItemDependencies } from "../src/intake";
import { createAdmission, dispatch, type ItemAdmission } from "../src/scheduler";
import { createLiveStatusProvider } from "../src/dashboard";
import { joinFakeWorkspace, workspaceAdmission, workspaceDispatch } from "./fake-workspace";
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

test("a blocked item names its blocker once in the journal and once more when it starts", async () => {
  const db = tempDb();
  try {
    item(db, "PAS-367", "running");
    item(db, "PAS-368", "queued", 1);
    db.run("INSERT INTO task_block VALUES('issue-PAS-367','issue-PAS-368')");
    const { lines, log } = journal();
    expect(await workspaceDispatch(db, { now: 1, log })).toEqual([]);
    expect(await workspaceDispatch(db, { now: 2, log })).toEqual([]);
    expect(await listItemHolds(sqliteDb(db))).toEqual([
      { itemId: "PAS-368", reason: "blocked", blockers: ["PAS-367"] },
    ]);
    expect(lines).toEqual(["item PAS-368 held: blocked by PAS-367"]);
    db.run("UPDATE work_item SET state='merged' WHERE id='PAS-367'");
    expect(await workspaceDispatch(db, { now: 3, log })).toEqual([]);
    expect(await listItemHolds(sqliteDb(db))).toEqual([
      { itemId: "PAS-368", reason: "blocked", blockers: ["PAS-367"] },
    ]);
    expect(
      (await createLiveStatusProvider(db).issues()).issues.find((entry) => entry.id === "PAS-368")
        ?.blockers,
    ).toEqual(["PAS-367"]);
    confirmFakeMerge(db, "PAS-367");
    expect(await workspaceDispatch(db, { now: 3, log })).toEqual(["PAS-368"]);
    expect(await listItemHolds(sqliteDb(db))).toEqual([]);
    expect(lines).toEqual(["item PAS-368 held: blocked by PAS-367", "item PAS-368 no longer held"]);
  } finally {
    db.close();
  }
});

function externalBlocker(db: Database, state: string) {
  item(db, "PAS-840");
  joinFakeWorkspace(db, "delegation");
  const workspaceId = db.query<{ id: string }, []>("SELECT id FROM workspace").get()!.id;
  const generation =
    db
      .query<{ generation: number }, [string]>(
        "SELECT generation FROM item_dependency_snapshot WHERE item_id=?",
      )
      .get("PAS-840")?.generation ?? 0;
  recordItemDependencies(
    db,
    { itemId: "PAS-840", workspaceId, expectedGeneration: generation },
    {
      edges: [{ blockerLinearIssueId: "issue-OPS-12", blockedLinearIssueId: "issue-PAS-840" }],
      states: new Map([["issue-OPS-12", state]]),
      identifiers: new Map([["issue-OPS-12", "OPS-12"]]),
    },
  );
}

for (const state of ["started", "unstarted"])
  test(`an item blocked by a ${state} issue Paws does not run names that issue`, async () => {
    const db = tempDb();
    const journaled: string[] = [];
    const restore = setJournalSink((line) => journaled.push(line));
    try {
      externalBlocker(db, state);
      const { lines, log } = journal();
      expect(await dispatch(db, { now: 1, log, admission: createAdmission({ db }) })).toEqual([]);
      expect(await listItemHolds(sqliteDb(db))).toEqual([
        { itemId: "PAS-840", reason: "blocked", blockers: ["OPS-12"] },
      ]);
      expect(lines).toEqual(["item PAS-840 held: blocked by OPS-12"]);
      expect(journaled).toEqual([]);
    } finally {
      restore();
      db.close();
    }
  });

test("a blocked hold without an open blocker is journaled as an inconsistency", async () => {
  const db = tempDb();
  const journaled: string[] = [];
  const restore = setJournalSink((line) => journaled.push(line));
  try {
    item(db, "PAS-841");
    const blocked: ItemAdmission = {
      canDispatchDelegation: async () => true,
      canStart: async () => ({ ok: false, held: "blocked" }),
      canMerge: async () => ({ ok: false, held: "blocked" }),
      steps: {
        canDispatchDelegation: () => syncSteps(() => true),
        canStart: () => syncSteps(() => ({ ok: false, held: "blocked" })),
      },
    };
    const { lines, log } = journal();
    expect(await dispatch(db, { now: 1, log, admission: blocked })).toEqual([]);
    expect(await dispatch(db, { now: 2, log, admission: blocked })).toEqual([]);
    expect(await listItemHolds(sqliteDb(db))).toEqual([
      { itemId: "PAS-841", reason: "blocked", blockers: [] },
    ]);
    expect(lines).toEqual(["item PAS-841 held: blocked by another issue"]);
    expect(journaled).toEqual([
      "scheduler inconsistency: item PAS-841 is held as blocked but has no open blocker",
    ]);
  } finally {
    restore();
    db.close();
  }
});

test("a ready item without a free slot, then over its owner cap, journals each new reason", async () => {
  const db = tempDb();
  try {
    item(db, "PAS-1", "running");
    item(db, "PAS-2", "queued", 1);
    const { lines, log } = journal();
    fullRunner(db);
    const now = Date.now();
    await workspaceDispatch(db, { now, log });
    expect(await listItemHolds(sqliteDb(db))).toEqual([
      { itemId: "PAS-2", reason: "slot", blockers: [] },
    ]);
    await workspaceDispatch(db, { now: now + 1, log });
    db.run("DELETE FROM runner_work");
    await workspaceDispatch(db, { now: now + 2, log, ownerCap: 1 });
    expect(await listItemHolds(sqliteDb(db))).toEqual([
      { itemId: "PAS-2", reason: "cap", blockers: [] },
    ]);
    expect(lines).toEqual([
      "item PAS-2 held: no free slot on any runner",
      "item PAS-2 held: its owner already runs the most tasks at once",
    ]);
  } finally {
    db.close();
  }
});

test("a project that holds an item is its held reason", async () => {
  const db = tempDb();
  try {
    item(db, "PAS-5");
    const { lines, log } = journal();
    const admission = workspaceAdmission(db, { authority: () => false });
    expect(await dispatch(db, { now: 1, log, admission })).toEqual([]);
    expect(await listItemHolds(sqliteDb(db))).toEqual([
      { itemId: "PAS-5", reason: "project", blockers: [] },
    ]);
    expect(lines).toEqual(["item PAS-5 held: its project has not released it yet"]);
  } finally {
    db.close();
  }
});

test("without a workspace every queued item is held for the workspace, journaled once", async () => {
  const db = tempDb();
  try {
    item(db, "PAS-7", "running");
    item(db, "PAS-8", "queued", 1);
    db.run("INSERT INTO task_block VALUES('issue-PAS-7','issue-PAS-8')");
    const { lines, log } = journal();
    expect(await workspaceDispatch(db, { now: 1, log })).toEqual([]);
    confirmFakeMerge(db, "PAS-7");
    db.run("UPDATE work_item SET state='merged' WHERE id='PAS-7'");
    item(db, "PAS-9", "queued", 2);
    const admission = createAdmission({ db, workspace: false });
    expect(await dispatch(db, { now: 2, log, admission })).toEqual([]);
    expect(await dispatch(db, { now: 3, log, admission })).toEqual([]);
    expect(await listItemHolds(sqliteDb(db))).toEqual([
      { itemId: "PAS-8", reason: "workspace", blockers: [] },
      { itemId: "PAS-9", reason: "workspace", blockers: [] },
    ]);
    expect(lines).toEqual([
      "item PAS-8 held: blocked by PAS-7",
      "item PAS-8 held: no Linear workspace",
      "item PAS-9 held: no Linear workspace",
    ]);
    expect(
      (await createLiveStatusProvider(db).issues()).issues.find((entry) => entry.id === "PAS-9")
        ?.held,
    ).toEqual({ reason: "workspace", blockers: [] });
  } finally {
    db.close();
  }
});

test("the status API carries the held reason of a queued item", async () => {
  const db = tempDb();
  try {
    item(db, "PAS-367", "running");
    item(db, "PAS-368", "queued", 1);
    db.run("INSERT INTO task_block VALUES('issue-PAS-367','issue-PAS-368')");
    await workspaceDispatch(db, { now: 1 });
    const items = (await createLiveStatusProvider(db).issues()).issues;
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
    legacyMigrate(db);
    db.run("INSERT INTO item_hold(item_id,reason,blockers) VALUES('PAS-9','workspace','[]')");
    expect(
      db.query("SELECT item_id, reason, blockers FROM item_hold ORDER BY item_id").all(),
    ).toEqual([
      { item_id: "PAS-8", reason: "blocked", blockers: '["PAS-7"]' },
      { item_id: "PAS-9", reason: "workspace", blockers: "[]" },
    ]);
  } finally {
    db.close();
  }
});

test("an item blocked only by an issue canceled in Linear is not held", async () => {
  const db = tempDb();
  try {
    externalBlocker(db, "canceled");
    const { lines, log } = journal();
    await dispatch(db, { now: 1, log, admission: createAdmission({ db }) });
    expect(await listItemHolds(sqliteDb(db))).toEqual([]);
    expect(lines).toEqual([]);
  } finally {
    db.close();
  }
});
