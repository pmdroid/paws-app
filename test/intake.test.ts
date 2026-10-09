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
  test("migration 002 names every epic and work-item state", () => {
    const migration = migrations.find((item) => item.id === "002_inbox_intake");
    expect(migration).toBeDefined();
    for (const state of EPIC_STATES) expect(migration?.sql).toContain(`'${state}'`);
    for (const state of WORK_ITEM_STATES) expect(migration?.sql).toContain(`'${state}'`);
    expect(migrations[0]?.id).toBe("001_jobs_outbox");
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
