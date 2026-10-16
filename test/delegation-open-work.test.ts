import { expect, test } from "bun:test";
import { bindLinearSessionTask, recordLinearInstallation } from "../src/db";
import {
  createItemReconciler,
  intakeDelegatedIssue,
  readyItems,
  syncItemDependencies,
} from "../src/intake";
import { createFakeLinearIssueLifecycle, createFakeTracker } from "../src/linear";
import { dispatchReadyItems } from "../src/scheduler";
import { tempDb } from "./helpers";

const issue = {
  linearIssueId: "only",
  identifier: "CAN-1",
  title: "Only",
  description: null,
  subIssues: [],
};

function install(db: ReturnType<typeof tempDb>, epicId: string): void {
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
  bindLinearSessionTask(db, "session", epicId, { actorId: "linear-person" });
}

test("a delegation whose only item is cancelled is no longer treated as running by reconciliation and readiness", async () => {
  const db = tempDb();
  const tracker = createFakeTracker([issue]);
  const lifecycle = createFakeLinearIssueLifecycle({
    id: "only",
    teamId: "team",
    stateType: "started",
    assigneeId: null,
    delegateId: "app",
  });
  const reconciler = createItemReconciler({
    db,
    tracker,
    lifecycle,
    onChanges: () => {},
  });
  try {
    const intake = await intakeDelegatedIssue(db, tracker, { linearIssueId: "only", now: 1000 });
    expect(intake.ok).toBe(true);
    if (!intake.ok) return;
    const itemId = intake.items[0]!.id;
    install(db, intake.epic.id);
    const target = { itemId, workspaceId: "workspace" };
    expect(readyItems(db, target).heldItemIds).toEqual([itemId]);
    await reconciler.reconcile(target);
    db.run("UPDATE work_item SET state='cancelled' WHERE id=?", [itemId]);
    expect(db.query("SELECT id FROM epic").all()).toEqual([]);
    expect(() => readyItems(db, target)).toThrow(/Dependency workspace or task ownership changed/);
    await expect(reconciler.reconcile(target)).rejects.toThrow(
      /Item reconciliation authority changed/,
    );
  } finally {
    await reconciler.close();
    db.close();
  }
});

test("a project item reads its parent issue from project_approval", async () => {
  const db = tempDb();
  const tracker = createFakeTracker([
    {
      linearIssueId: "child-issue",
      identifier: "PRJ-2",
      title: "Child",
      description: null,
      subIssues: [],
    },
  ]);
  const lifecycle = createFakeLinearIssueLifecycle({
    id: "child-issue",
    teamId: "team",
    stateType: "started",
    assigneeId: null,
    delegateId: null,
  });
  const seen: string[] = [];
  const listDeps = tracker.listDeps.bind(tracker);
  tracker.listDeps = async (id) => {
    seen.push(id);
    return listDeps(id);
  };
  try {
    const intake = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "child-issue",
      now: 1000,
    });
    expect(intake.ok).toBe(true);
    if (!intake.ok) return;
    install(db, intake.epic.id);
    db.run(
      `INSERT INTO project_approval(id,workspace_id,project_id,actor_id,lead_user_id,generation,preview,created_at,expires_at,approved_at,source)
       VALUES('approval','workspace','parent-issue','person','person','1','{}',1000,9000,1000,'parent')`,
    );
    db.run("UPDATE work_item SET project_approval_id='approval' WHERE id=?", [intake.items[0]!.id]);
    seen.length = 0;
    await syncItemDependencies(db, {
      itemId: intake.items[0]!.id,
      workspaceId: "workspace",
      expectedGeneration: 0,
      tracker,
      lifecycle,
    });
    expect(seen).toEqual(["parent-issue", "child-issue"]);
  } finally {
    db.close();
  }
});

test("the scheduler admits an item without reading the epic table", async () => {
  const db = tempDb();
  const tracker = createFakeTracker([issue]);
  try {
    const intake = await intakeDelegatedIssue(db, tracker, { linearIssueId: "only", now: 1 });
    expect(intake.ok).toBe(true);
    if (!intake.ok) return;
    db.run("PRAGMA foreign_keys = OFF");
    db.run("DELETE FROM epic WHERE id=?", [intake.epic.id]);
    db.run("PRAGMA foreign_keys = ON");
    expect(db.query("SELECT id FROM epic").get()).toBeNull();
    expect(
      dispatchReadyItems(db, {
        now: 2,
        legacyReadyItemIds: intake.items.map((item) => item.id),
      }),
    ).toEqual([intake.items[0]!.id]);
  } finally {
    db.close();
  }
});
