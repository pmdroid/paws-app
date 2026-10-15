import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  bindLinearSessionTask,
  bindWorkItemRepository,
  ensureLinearSession,
  insertQueuedItem,
  recordLinearInstallation,
} from "../src/db";
import { intakeDelegatedIssue, syncEpicDependencies } from "../src/intake";
import { createFakeLinearIssueLifecycle, createFakeTracker } from "../src/linear";
import { dispatchReadyItems, saveSchedulingContext } from "../src/scheduler";
import { tempDb } from "./helpers";

const repository = { owner: "owner", repo: "repo", remoteUrl: "https://example.invalid/repo.git" };

function brief(description: string): string {
  return JSON.stringify({
    issue: {
      source: "linear",
      issueId: "issue",
      identifier: "SCH-1",
      title: "Work",
      description,
      acceptanceCriteria: null,
    },
    epic: null,
  });
}

test("three ready items in one project and repository are all admitted", () => {
  const db = tempDb();
  try {
    const ids = ["a", "b", "c"];
    for (const [index, id] of ids.entries()) {
      insertQueuedItem(db, { id, now: index });
      bindWorkItemRepository(db, id, repository);
      saveSchedulingContext(db, { itemId: id, projectId: "project", paths: ["src/same.ts"] });
    }
    assert.deepEqual(dispatchReadyItems(db, { now: 1000, legacyReadyItemIds: ids }), ids);
    const rows = db
      .query<{ project_key: string; paths: string; hot: number }, []>(
        "SELECT project_key, paths, hot FROM scheduler_admission ORDER BY item_id",
      )
      .all();
    assert.deepEqual(
      rows,
      ids.map(() => ({ project_key: "*", paths: "[]", hot: 0 })),
    );
  } finally {
    db.close();
  }
});

test("two ready items that share a Linear session are both admitted", () => {
  const db = tempDb();
  try {
    insertQueuedItem(db, { id: "one", now: 1 });
    insertQueuedItem(db, { id: "two", now: 2 });
    db.run("UPDATE work_item SET epic_id=? WHERE id=?", ["epic-one", "two"]);
    ensureLinearSession(db, { sessionId: "shared", issueId: "lin-one", now: 1000 });
    bindLinearSessionTask(db, "shared", "epic-one");
    const sessions = db
      .query<{ id: string; sessionId: string | null }, []>(
        `SELECT i.id, t.session_id AS sessionId FROM work_item i
         JOIN epic e ON e.id=i.epic_id
         LEFT JOIN linear_session_task t ON t.epic_id=e.id ORDER BY i.id`,
      )
      .all();
    assert.deepEqual(sessions, [
      { id: "one", sessionId: "shared" },
      { id: "two", sessionId: "shared" },
    ]);
    assert.deepEqual(dispatchReadyItems(db, { now: 1000, legacyReadyItemIds: ["one", "two"] }), [
      "one",
      "two",
    ]);
  } finally {
    db.close();
  }
});

test("two ready items with overlapping path hints are both admitted", () => {
  const db = tempDb();
  try {
    for (const [index, id] of ["left", "right"].entries()) {
      insertQueuedItem(db, { id, now: index });
      bindWorkItemRepository(db, id, repository);
      db.run("UPDATE work_item SET brief=? WHERE id=?", [
        brief(index === 0 ? "paths: src/shared/**" : "paths: src/shared/file.ts"),
        id,
      ]);
    }
    assert.deepEqual(dispatchReadyItems(db, { now: 1000, legacyReadyItemIds: ["left", "right"] }), [
      "left",
      "right",
    ]);
    const rows = db
      .query<{ paths: string; hot: number }, []>(
        "SELECT paths, hot FROM scheduler_admission ORDER BY item_id",
      )
      .all();
    assert.deepEqual(rows, [
      { paths: "[]", hot: 0 },
      { paths: "[]", hot: 0 },
    ]);
  } finally {
    db.close();
  }
});

test("a task_block dependency is admitted only after its blocker item is merged", async () => {
  const db = tempDb();
  try {
    const tracker = createFakeTracker([
      {
        linearIssueId: "parent",
        identifier: "DEP-1",
        title: "Parent",
        description: null,
        subIssues: ["a", "b"].map((id, index) => ({
          linearIssueId: id,
          identifier: `DEP-${index + 2}`,
          title: id,
        })),
      },
    ]);
    const lifecycle = createFakeLinearIssueLifecycle({
      id: "a",
      teamId: "team",
      stateType: "started",
      assigneeId: null,
      delegateId: null,
    });
    const intake = await intakeDelegatedIssue(db, tracker, { linearIssueId: "parent", now: 1000 });
    assert(intake.ok);
    const ids = new Map(intake.items.map((item) => [item.linearIssueId, item.id]));
    db.run("INSERT INTO workspace VALUES('workspace','org','Workspace',1000)");
    recordLinearInstallation(db, {
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      sessionId: "session",
      teamId: "team",
      observedAtMs: 1000,
    });
    bindLinearSessionTask(db, "session", intake.epic.id, { actorId: "owner" });
    const target = { epicId: intake.epic.id, workspaceId: "workspace" };
    await syncEpicDependencies(db, {
      ...target,
      expectedGeneration: 0,
      tracker,
      lifecycle,
    });
    db.run(
      "INSERT INTO task_block(blocker_linear_issue_id, blocked_linear_issue_id) VALUES('a', 'b')",
    );
    assert.equal(
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM work_item_block").get()!.n,
      0,
    );
    const blocker = ids.get("a");
    const blocked = ids.get("b");
    assert(blocker);
    assert(blocked);
    assert.deepEqual(dispatchReadyItems(db, { now: 1000 }), [blocker]);
    db.run("UPDATE work_item SET state='merged' WHERE id=?", [blocker]);
    assert.deepEqual(dispatchReadyItems(db, { now: 1001 }), [blocked]);
  } finally {
    db.close();
  }
});

test("a longer task_block chain is admitted before an unrelated ready item", () => {
  const db = tempDb();
  try {
    for (const [index, id] of ["d", "c", "b", "a"].entries()) {
      insertQueuedItem(db, { id, now: index });
      bindWorkItemRepository(db, id, repository);
    }
    db.run(
      "INSERT INTO task_block(blocker_linear_issue_id, blocked_linear_issue_id) VALUES('lin-item-a', 'lin-item-b')",
    );
    db.run(
      "INSERT INTO task_block(blocker_linear_issue_id, blocked_linear_issue_id) VALUES('lin-item-b', 'lin-item-c')",
    );
    const admitted = dispatchReadyItems(db, {
      now: 1000,
      legacyReadyItemIds: ["d", "c", "b", "a"],
    });
    assert.deepEqual(admitted, ["a", "b", "d", "c"]);
    assert.ok(admitted.indexOf("a") < admitted.indexOf("d"));
  } finally {
    db.close();
  }
});

test("task_block depth stays on the active item when a merged row shares its issue", () => {
  const db = tempDb();
  try {
    for (const [index, id] of ["old", "d", "b", "a"].entries()) {
      insertQueuedItem(db, { id, now: index });
      bindWorkItemRepository(db, id, repository);
    }
    db.run("UPDATE work_item SET state='merged', linear_issue_id='lin-item-a' WHERE id='old'");
    db.run(
      "INSERT INTO task_block(blocker_linear_issue_id, blocked_linear_issue_id) VALUES('lin-item-a', 'lin-item-b')",
    );
    assert.deepEqual(dispatchReadyItems(db, { now: 1000, legacyReadyItemIds: ["a", "b", "d"] }), [
      "a",
      "d",
      "b",
    ]);
  } finally {
    db.close();
  }
});
