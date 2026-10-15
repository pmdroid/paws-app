import { describe, expect, test } from "bun:test";
import { EPIC_STATES, WORK_ITEM_STATES } from "../src/core";
import { migrations } from "../src/db";
import { cycleMessage, intakeDelegatedIssue, orderByBlocks, queueMessage } from "../src/intake";
import { createFakeTracker, type EpicSnapshot } from "../src/linear";
import { tempDb } from "./helpers";

const parent: EpicSnapshot = {
  linearIssueId: "parent",
  identifier: "ENG-1",
  title: "Add CSV export",
  description: null,
  subIssues: [
    { linearIssueId: "a", identifier: "ENG-2", title: "export endpoint" },
    { linearIssueId: "b", identifier: "ENG-3", title: "same file" },
    { linearIssueId: "c", identifier: "ENG-4", title: "decision" },
  ],
};

describe("intake", () => {
  test("the migrated schema accepts every epic and work-item state", () => {
    const db = tempDb();
    const schema = (name: string) =>
      db.query<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE name = ?").get(name)
        ?.sql;
    for (const state of EPIC_STATES) expect(schema("epic")).toContain(`'${state}'`);
    for (const state of WORK_ITEM_STATES) expect(schema("work_item")).toContain(`'${state}'`);
    expect(migrations[0]?.id).toBe("001_jobs_outbox");
    db.close();
  });

  test("orders a parent by a blocks edge and keeps the original tie break", async () => {
    const db = tempDb();
    const tracker = createFakeTracker([parent]);
    tracker.deps.set("parent", [{ blockerLinearIssueId: "a", blockedLinearIssueId: "b" }]);
    const result = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "parent",
      sessionId: "ses_1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.epic.state).toBe("running");
    expect(result.items.map((item) => item.linearIdentifier)).toEqual(["ENG-2", "ENG-3", "ENG-4"]);
    expect(result.items.map((item) => item.state)).toEqual(["queued", "queued", "queued"]);
    expect(result.items[0]?.branchName).toBe("paws/eng-2");
    expect(tracker.progress.map((update) => update.body)).toEqual([
      queueMessage(["ENG-2", "ENG-3", "ENG-4"], false),
    ]);
    const blocks = db
      .query<{ blocker: string; blocked: string }, []>(
        "SELECT blocker_linear_issue_id AS blocker, blocked_linear_issue_id AS blocked FROM work_item_block",
      )
      .all();
    expect(blocks).toEqual([{ blocker: "a", blocked: "b" }]);
    const again = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "parent",
      sessionId: "ses_1",
    });
    expect(again.ok && again.alreadyExisted).toBe(true);
    expect(tracker.progress).toHaveLength(1);
    db.close();
  });

  test("a lone delegated issue is a queue of one", async () => {
    const db = tempDb();
    const tracker = createFakeTracker([
      {
        linearIssueId: "only",
        identifier: "ENG-9",
        title: "Fix the header",
        description: "details",
        subIssues: [],
      },
    ]);
    const result = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "only",
      sessionId: "ses_9",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      linearIdentifier: "ENG-9",
      state: "queued",
      branchName: "paws/eng-9",
    });
    expect(tracker.progress[0]?.body).toBe("Picked up ENG-9.");
    db.close();
  });

  test("adopting a parent finishes the epic without items and announces separate sessions", async () => {
    const db = tempDb();
    const tracker = createFakeTracker([
      {
        linearIssueId: "parent",
        identifier: "ENG-1",
        title: "Parent",
        description: null,
        subIssues: [{ linearIssueId: "only", identifier: "ENG-2", title: "Only child" }],
      },
    ]);
    let epicExisted = true;
    const result = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "parent",
      sessionId: "ses_1",
      adoptParent: () => {
        epicExisted = db.query("SELECT 1 FROM epic").get() !== null;
        return true;
      },
    });
    expect(epicExisted).toBe(false);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alreadyExisted).toBe(false);
    expect(result.items).toEqual([]);
    expect(result.epic.state).toBe("done");
    expect(tracker.progress.map((update) => update.body)).toEqual([
      "Picked up 1 sub-issue. Each one runs in its own session.",
    ]);
    const again = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "parent",
      sessionId: "ses_1",
      adoptParent: () => {
        throw new Error("replay must not adopt again");
      },
    });
    expect(again.ok && again.alreadyExisted).toBe(true);
    if (!again.ok) return;
    expect(again.items).toEqual([]);
    expect(again.epic.id).toBe(result.epic.id);
    expect(tracker.progress).toHaveLength(1);
    db.close();
  });

  test("adoptParent false keeps the ordered multi-item epic", async () => {
    const db = tempDb();
    const tracker = createFakeTracker([parent]);
    const result = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "parent",
      sessionId: "ses_1",
      adoptParent: () => false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.epic.state).toBe("running");
    expect(result.items.map((item) => item.linearIdentifier)).toEqual(["ENG-2", "ENG-3", "ENG-4"]);
    expect(tracker.progress.map((update) => update.body)).toEqual([
      queueMessage(["ENG-2", "ENG-3", "ENG-4"], false),
    ]);
    expect(db.query("SELECT id FROM project_approval").all()).toHaveLength(0);
    db.close();
  });

  test("a blocks cycle does not adopt a parent project", async () => {
    const db = tempDb();
    const tracker = createFakeTracker([parent]);
    tracker.deps.set("a", [
      { blockerLinearIssueId: "a", blockedLinearIssueId: "b" },
      { blockerLinearIssueId: "b", blockedLinearIssueId: "a" },
    ]);
    let called = false;
    const result = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "parent",
      sessionId: "ses_1",
      adoptParent: () => {
        called = true;
        return true;
      },
    });
    expect(called).toBe(false);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("cycle");
    expect(db.query("SELECT id FROM project_approval").all()).toHaveLength(0);
    db.close();
  });

  test("a blocks cycle is reported and nothing is queued", async () => {
    const db = tempDb();
    const tracker = createFakeTracker([parent]);
    tracker.deps.set("a", [
      { blockerLinearIssueId: "a", blockedLinearIssueId: "b" },
      { blockerLinearIssueId: "b", blockedLinearIssueId: "a" },
    ]);
    const result = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "parent",
      sessionId: "ses_1",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("cycle");
    expect(result.identifiers).toEqual(["ENG-2", "ENG-3"]);
    expect(result.epic.state).toBe("stalled");
    const items = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM work_item").get();
    expect(items?.n).toBe(0);
    expect(tracker.progress[0]).toMatchObject({
      kind: "error",
      body: cycleMessage(["ENG-2", "ENG-3"]),
    });
    const ordered = orderByBlocks(
      [
        { linearIssueId: "a", identifier: "ENG-2", title: "a" },
        { linearIssueId: "b", identifier: "ENG-3", title: "b" },
      ],
      [
        { blockerLinearIssueId: "a", blockedLinearIssueId: "b" },
        { blockerLinearIssueId: "b", blockedLinearIssueId: "a" },
      ],
    );
    expect(ordered.ok).toBe(false);
    db.close();
  });
});
