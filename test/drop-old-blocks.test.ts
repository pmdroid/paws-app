import { expect, test } from "bun:test";
import { FakeClock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  bindLinearSessionTask,
  insertRun,
  listOutbox,
  listWorkItemBlocks,
  migrate,
  migrations,
  openDatabase,
  recordLinearInstallation,
  saveRunResult,
  setCurrentRun,
} from "../src/db";
import { createItemReconciler, intakeDelegatedIssue, readyItems } from "../src/intake";
import { createFakeLinearIssueLifecycle, createFakeTracker } from "../src/linear";
import { Orchestrator } from "../src/loop";
import { tempDb, tempHome } from "./helpers";

test("migration 059 drops the old block tables and task_block holds each dependent", async () => {
  const db = tempDb();
  const clock = new FakeClock(1_000);
  const ready: string[] = [];
  const orchestrator = new Orchestrator({
    db,
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
    clock,
    pawsRoot: tempHome(),
    dispatchReady({ legacyReadyItemIds }) {
      ready.push(...legacyReadyItemIds);
    },
  });
  let closeReconciler: (() => Promise<void>) | undefined;
  try {
    expect(migrations.some((migration) => migration.id === "059_drop_old_blocks")).toBe(true);
    expect(
      db.query("SELECT 1 FROM schema_migration WHERE id = '059_drop_old_blocks'").get(),
    ).toBeTruthy();
    expect(
      db
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master
           WHERE name IN ('work_item_block','external_dep','epic_execution_control','external_dep_blocker')
              OR tbl_name IN ('work_item_block','external_dep','epic_execution_control')`,
        )
        .all(),
    ).toEqual([]);

    for (const [id, position] of [
      ["hold-0", 0],
      ["hold-1", 1],
    ] as const) {
      db.run(
        "INSERT INTO work_item(id,delegation_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at,session_key) VALUES(?,?,?,?,?,'queued',?,?,1000,'hold-session')",
        [id, "hold", id, id, id, `paws/${id}`, position],
      );
    }
    db.run(
      "INSERT INTO work_item(id,delegation_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at) VALUES('stale-1','stale','hold-1','stale-1','stale','cancelled','paws/stale-1',0,5000)",
    );
    db.run(
      "INSERT INTO task_block(blocker_linear_issue_id,blocked_linear_issue_id) VALUES('hold-0','hold-1')",
    );
    const edge = {
      delegationId: "hold",
      blockerLinearIssueId: "hold-0",
      blockedLinearIssueId: "hold-1",
    };
    expect(listWorkItemBlocks(db)).toEqual([edge]);
    expect(listWorkItemBlocks(db, "hold")).toEqual([edge]);
    expect(listWorkItemBlocks(db, "stale")).toEqual([]);

    orchestrator.reconcileExecution();
    expect(ready).toEqual(["hold-0"]);
    expect(orchestrator.dependencyHandoff("hold-1")).toBeUndefined();
    db.run("UPDATE work_item SET state = 'merged' WHERE id = 'hold-0'");
    const run = insertRun(db, {
      itemId: "hold-0",
      now: clock.now(),
      status: "ended",
      kind: "implement",
      agent: "codex",
      freshSession: true,
    });
    saveRunResult(db, run.id, "Published the schema.", clock.now());
    setCurrentRun(db, "hold-0", run.id);
    expect(orchestrator.dependencyHandoff("hold-1")).toBe(
      "Completed dependencies:\nhold-0: Published the schema.",
    );

    for (const [id, position] of [
      ["notice-0", 0],
      ["notice-1", 1],
    ] as const) {
      db.run(
        "INSERT INTO work_item(id,delegation_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at,session_key) VALUES(?,?,?,?,?,'queued',?,?,1000,'notice-session')",
        [id, "notice", id, id, id, `paws/${id}`, position],
      );
    }
    db.run(
      "INSERT INTO task_block(blocker_linear_issue_id,blocked_linear_issue_id) VALUES('notice-0','notice-1')",
    );
    orchestrator.applyDelegationChanges({
      delegationId: "notice",
      sessionId: "notice-session",
      addedItemIds: [],
      removedItemIds: [],
      specChangedItemIds: [],
      canceledItemIds: ["notice-0"],
      parentCanceled: false,
    });
    expect(
      listOutbox(db).some((row) => {
        const body = (row.payload as { body?: string }).body ?? "";
        return body.includes("notice-1") && body.includes("remain held");
      }),
    ).toBe(true);

    const tracker = createFakeTracker([
      {
        linearIssueId: "parent",
        identifier: "DEP-1",
        title: "Parent",
        description: null,
        subIssues: [{ linearIssueId: "b", identifier: "DEP-2", title: "B" }],
      },
    ]);
    const lifecycle = createFakeLinearIssueLifecycle({
      id: "parent",
      teamId: "team",
      stateType: "started",
      assigneeId: null,
      delegateId: null,
    });
    lifecycle.issues.set("b", { ...lifecycle.issue, id: "b" });
    lifecycle.issues.set("outside", { ...lifecycle.issue, id: "outside", stateType: "started" });
    const intake = await intakeDelegatedIssue(db, tracker, { linearIssueId: "parent", now: 1000 });
    expect(intake.ok).toBe(true);
    if (!intake.ok) return;
    db.run("INSERT INTO workspace VALUES('workspace','org','Workspace',1000)");
    recordLinearInstallation(db, {
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      sessionId: "session",
      teamId: "team",
      observedAtMs: 1000,
    });
    bindLinearSessionTask(db, "session", intake.delegation.id, { actorId: "owner" });
    const blocked = intake.items.find((item) => item.linearIssueId === "b");
    expect(blocked).toBeDefined();
    db.run(
      "INSERT INTO task_block(blocker_linear_issue_id,blocked_linear_issue_id) VALUES('outside','b')",
    );
    tracker.deps.set("parent", [{ blockerLinearIssueId: "outside", blockedLinearIssueId: "b" }]);
    const reconciler = createItemReconciler({
      db,
      tracker,
      lifecycle,
      onChanges() {},
    });
    closeReconciler = () => reconciler.close();
    expect(await reconciler.issueChanged({ issueId: "outside", organizationId: "other" })).toEqual(
      [],
    );
    expect(await reconciler.issueChanged({ issueId: "outside", organizationId: "org" })).toEqual([
      { itemId: blocked!.id, workspaceId: "workspace" },
    ]);
    expect(
      readyItems(db, { itemId: blocked!.id, workspaceId: "workspace" }).readyItemIds,
    ).not.toContain(blocked!.id);
  } finally {
    await closeReconciler?.();
    await orchestrator.shutdown();
    db.close();
  }
});

test("migration 059 is append-only and runs after the task_block copy", () => {
  const db = openDatabase(":memory:");
  try {
    migrate(db);
    const ids = db
      .query<{ id: string }, []>("SELECT id FROM schema_migration ORDER BY rowid")
      .all()
      .map((row) => row.id);
    expect(ids.at(-1)).toBe("073_closeout_skip_request");
    expect(ids.indexOf("058_one_active_item")).toBeLessThan(ids.indexOf("059_drop_old_blocks"));
    expect(ids.indexOf("059_drop_old_blocks")).toBeLessThan(
      ids.indexOf("060_session_link_on_item"),
    );
    expect(ids.indexOf("060_session_link_on_item")).toBeLessThan(
      ids.indexOf("061_drop_old_session_link"),
    );
    expect(ids.indexOf("061_drop_old_session_link")).toBeLessThan(
      ids.indexOf("062_item_dependency_snapshot"),
    );
    expect(ids.indexOf("062_item_dependency_snapshot")).toBeLessThan(
      ids.indexOf("063_item_reconciliation"),
    );
    expect(ids.indexOf("063_item_reconciliation")).toBeLessThan(
      ids.indexOf("064_work_item_without_epic_fk"),
    );
    expect(ids.indexOf("064_work_item_without_epic_fk")).toBeLessThan(ids.indexOf("065_drop_epic"));
    expect(ids.indexOf("065_drop_epic")).toBeLessThan(ids.indexOf("066_repository_catalog"));
  } finally {
    db.close();
  }
});
