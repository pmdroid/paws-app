import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  bindLinearSessionTask,
  migrations,
  migrate,
  openDatabase,
  recordLinearInstallation,
} from "../src/db";
import { createItemReconciler, intakeDelegatedIssue } from "../src/intake";
import { createFakeLinearIssueLifecycle, createFakeTracker } from "../src/linear";

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

test("migration 063 copies a request, an effect and a policy onto the non-terminal item", () => {
  const db = openDatabase(":memory:");
  try {
    applyMigrationsUntil(db, "062_item_dependency_snapshot");
    expect(
      db.query("SELECT 1 FROM schema_migration WHERE id = '063_item_reconciliation'").get(),
    ).toBeNull();
    db.run(
      "INSERT INTO workspace(id,linear_organization_id,name,created_at) VALUES('workspace','org','Workspace',1)",
    );
    db.run(
      "INSERT INTO workspace_user(id,linear_user_id,name,email) VALUES('person','linear-person','Person','person@example.test')",
    );
    db.run(
      "INSERT INTO epic(id,linear_issue_id,linear_identifier,title,state,created_at) VALUES('epic','parent','DEP','Parent','running',1)",
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
    db.run(
      "INSERT INTO epic_reconciliation_request(epic_id,workspace_id,token) VALUES('epic','workspace','request-token')",
    );
    db.run(
      "INSERT INTO epic_reconciliation_effect(epic_id,item_id,kind,token) VALUES('epic','running-item','spec','effect-token')",
    );
    db.run(
      "INSERT INTO external_blocker_policy(workspace_id,epic_id,blocker_issue_id,policy,user_id,revision) VALUES('workspace','epic','blocker','{\"blockerLinearIssueId\":\"blocker\",\"outcome\":\"completion\"}','person',3)",
    );
    migrate(db, { until: "129_parent_delegation" });
    expect(
      db
        .query<{ itemId: string; workspaceId: string; token: string }, []>(
          "SELECT item_id AS itemId, workspace_id AS workspaceId, token FROM item_reconciliation_request ORDER BY item_id",
        )
        .all(),
    ).toEqual([
      { itemId: "queued-item", workspaceId: "workspace", token: "request-token" },
      { itemId: "running-item", workspaceId: "workspace", token: "request-token" },
    ]);
    expect(
      db
        .query<{ itemId: string; kind: string; token: string }, []>(
          "SELECT item_id AS itemId, kind, token FROM item_reconciliation_effect",
        )
        .all(),
    ).toEqual([{ itemId: "running-item", kind: "spec", token: "effect-token" }]);
    expect(
      db
        .query<{ itemId: string; blockerIssueId: string; revision: number }, []>(
          "SELECT item_id AS itemId, blocker_issue_id AS blockerIssueId, revision FROM item_blocker_policy ORDER BY item_id",
        )
        .all(),
    ).toEqual([
      { itemId: "queued-item", blockerIssueId: "blocker", revision: 3 },
      { itemId: "running-item", blockerIssueId: "blocker", revision: 3 },
    ]);
    for (const name of [
      "epic_reconciliation_request",
      "epic_reconciliation_effect",
      "external_blocker_policy",
      "epic",
    ])
      expect(
        db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
      ).toBeNull();
  } finally {
    db.close();
  }
});

test("a spec change on the item's issue is reconciled through the item", async () => {
  const db = openDatabase(":memory:");
  try {
    migrate(db);
    const tracker = createFakeTracker([
      {
        linearIssueId: "parent",
        identifier: "SYNC-1",
        title: "Parent",
        description: "Parent criteria",
        subIssues: [
          { linearIssueId: "child", identifier: "SYNC-2", title: "Child", description: "Original" },
        ],
      },
    ]);
    const lifecycle = createFakeLinearIssueLifecycle({
      id: "parent",
      teamId: "team",
      stateType: "started",
      assigneeId: null,
      delegateId: "app",
    });
    lifecycle.issues.set("child", { ...lifecycle.issue, id: "child" });
    const intake = await intakeDelegatedIssue(db, tracker, { linearIssueId: "parent", now: 1000 });
    expect(intake.ok).toBe(true);
    if (!intake.ok) return;
    const itemId = intake.items[0]!.id;
    db.run("INSERT INTO workspace VALUES('workspace','org','Workspace',1000)");
    db.run(
      "INSERT INTO workspace_user VALUES('person','linear-person','Person','person@example.test')",
    );
    recordLinearInstallation(db, {
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      sessionId: "session",
      teamId: "team",
      observedAtMs: 1000,
    });
    bindLinearSessionTask(db, "session", intake.delegation.id, { actorId: "linear-person" });
    const changed: string[][] = [];
    const reconciler = createItemReconciler({
      db,
      tracker,
      lifecycle,
      onChanges(changes) {
        changed.push(changes.specChangedItemIds);
      },
    });
    await reconciler.reconcile({ itemId, workspaceId: "workspace" });
    const specification = () =>
      db
        .query<{ revision: number }, [string]>(
          "SELECT revision FROM work_item_specification WHERE item_id=?",
        )
        .get(itemId)!;
    expect(specification().revision).toBe(1);
    expect(changed.at(-1)).toEqual([]);
    tracker.epics.get("parent")!.subIssues[0]!.description = "Changed acceptance criteria";
    await reconciler.reconcile({ itemId, workspaceId: "workspace" });
    expect(specification().revision).toBe(2);
    expect(changed.at(-1)).toEqual([itemId]);
    expect(
      db
        .query(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'epic_reconciliation_request'",
        )
        .get(),
    ).toBeNull();
    expect(
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM item_reconciliation_request").get()!.n,
    ).toBe(0);
    await reconciler.close();
  } finally {
    db.close();
  }
});

test("a reconcile handed the intake's reads writes the scheduler rows without reading Linear", async () => {
  const db = openDatabase(":memory:");
  try {
    migrate(db);
    const snapshot = {
      linearIssueId: "issue",
      identifier: "ONE-1",
      title: "Lone issue",
      description: "Criteria",
      teamId: "team",
      stateType: "unstarted",
      subIssues: [],
    };
    const intake = await intakeDelegatedIssue(db, createFakeTracker([snapshot]), {
      linearIssueId: "issue",
      now: 1000,
    });
    expect(intake.ok).toBe(true);
    if (!intake.ok) return;
    const itemId = intake.items[0]!.id;
    db.run("INSERT INTO workspace VALUES('workspace','org','Workspace',1000)");
    recordLinearInstallation(db, {
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      sessionId: "session",
      teamId: "team",
      observedAtMs: 1000,
    });
    bindLinearSessionTask(db, "session", intake.delegation.id);
    const unread = async (): Promise<never> => {
      throw new Error("The intake's reads must not be repeated");
    };
    const reconciler = createItemReconciler({
      db,
      tracker: { loadEpic: unread, listDeps: unread },
      lifecycle: { inspect: unread },
      onChanges() {},
    });
    await reconciler.reconcile({
      itemId,
      workspaceId: "workspace",
      known: { snapshot, edges: [] },
    });
    expect(
      db.query("SELECT present FROM work_item_specification WHERE item_id=?").get(itemId),
    ).toEqual({ present: 1 });
    expect(
      db.query("SELECT generation FROM item_dependency_snapshot WHERE item_id=?").get(itemId),
    ).toEqual({ generation: 1 });
    await reconciler.close();
  } finally {
    db.close();
  }
});
