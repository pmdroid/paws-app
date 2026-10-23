import { describe, expect, test } from "bun:test";
import { WORK_ITEM_STATES } from "../src/core";
import { listTaskBlockers, migrations } from "../src/db";
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
  test("the migrated schema accepts every work-item state", () => {
    const db = tempDb();
    const schema = (name: string) =>
      db.query<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE name = ?").get(name)
        ?.sql;
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'epic'").get(),
    ).toBeNull();
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
    expect(result.delegation.state).toBe("running");
    expect(result.items.map((item) => item.linearIdentifier)).toEqual(["ENG-2", "ENG-3", "ENG-4"]);
    expect(result.items.map((item) => item.state)).toEqual(["queued", "queued", "queued"]);
    expect(result.items[0]?.branchName).toBe("paws/eng-2");
    expect(tracker.progress.map((update) => update.body)).toEqual([
      queueMessage(["ENG-2", "ENG-3", "ENG-4"], false),
    ]);
    const blocks = db
      .query<{ blocker: string; blocked: string }, []>(
        "SELECT blocker_linear_issue_id AS blocker, blocked_linear_issue_id AS blocked FROM task_block",
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

  test("adopting a parent finishes the delegation without items and leaves the parent session to its summary", async () => {
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
        epicExisted =
          db
            .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'epic'")
            .get() !== null;
        db.run("INSERT INTO workspace VALUES('workspace','org','Workspace',1000)");
        db.run(
          "INSERT INTO workspace_user VALUES('person','linear-person','Person','person@example.test')",
        );
        db.run(
          `INSERT INTO project_approval(id,workspace_id,project_id,actor_id,lead_user_id,generation,preview,created_at,expires_at,approved_at,source)
           VALUES('approval','workspace','parent','person','person','parent:ses_1','{"project":{"name":"Parent","identifier":"ENG-1"}}',1,1,1,'parent')`,
        );
        return true;
      },
    });
    expect(epicExisted).toBe(false);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alreadyExisted).toBe(false);
    expect(result.items).toEqual([]);
    expect(result.delegation.state).toBe("done");
    expect(result.delegation.id).toBe("approval");
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'epic'").all(),
    ).toEqual([]);
    expect(tracker.progress.map((update) => update.body)).toEqual([]);
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
    expect(again.delegation.id).toBe(result.delegation.id);
    expect(tracker.progress).toHaveLength(0);
    db.close();
  });

  test("adoptParent false keeps the ordered multi-item delegation", async () => {
    const db = tempDb();
    const tracker = createFakeTracker([parent]);
    const result = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "parent",
      sessionId: "ses_1",
      adoptParent: () => false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.delegation.state).toBe("running");
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
    expect(result.delegation.state).toBe("stalled");
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

  test("intake stores internal and external task blocks for the queued issues", async () => {
    const db = tempDb();
    const tracker = createFakeTracker([parent]);
    tracker.deps.set("parent", [
      { blockerLinearIssueId: "a", blockedLinearIssueId: "b" },
      { blockerLinearIssueId: "outside", blockedLinearIssueId: "b" },
      { blockerLinearIssueId: "b", blockedLinearIssueId: "outside" },
    ]);
    const result = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "parent",
      sessionId: "ses_1",
    });
    expect(result.ok).toBe(true);
    expect(listTaskBlockers(db, "b")).toEqual(["a", "outside"]);
    expect(listTaskBlockers(db, "a")).toEqual([]);
    expect(listTaskBlockers(db, "outside")).toEqual([]);
    db.close();
  });

  test("an issue already active in another session is rejected and creates nothing", async () => {
    const db = tempDb();
    const tracker = createFakeTracker([
      {
        linearIssueId: "only",
        identifier: "ENG-9",
        title: "Fix the header",
        description: null,
        subIssues: [],
      },
    ]);
    const first = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "only",
      sessionId: "ses_1",
      taskKey: "first",
    });
    expect(first.ok).toBe(true);
    const message =
      "ENG-9 has an unfinished attempt in another Paws session. Reply in that session to continue, or stop it before starting a new one.";
    await expect(
      intakeDelegatedIssue(db, tracker, {
        linearIssueId: "only",
        sessionId: "ses_2",
        taskKey: "second",
      }),
    ).rejects.toThrow(message);
    expect(tracker.progress).toContainEqual(
      expect.objectContaining({ sessionId: "ses_2", kind: "error", body: message }),
    );
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'epic'").all(),
    ).toHaveLength(0);
    expect(db.query("SELECT id FROM work_item").all()).toHaveLength(1);
    expect(db.query<{ state: string }, []>("SELECT state FROM work_item").get()?.state).toBe(
      "queued",
    );
    db.close();
  });

  test.each(["merged", "completed", "cancelled"] as const)(
    "delegating an issue whose earlier item is %s creates a new item",
    async (state) => {
      const db = tempDb();
      const tracker = createFakeTracker([
        {
          linearIssueId: "only",
          identifier: "ENG-9",
          title: "Fix the header",
          description: null,
          subIssues: [],
        },
      ]);
      const first = await intakeDelegatedIssue(db, tracker, {
        linearIssueId: "only",
        sessionId: "ses_1",
        taskKey: "first",
      });
      if (!first.ok) throw new Error("expected intake");
      db.run("UPDATE work_item SET state = ? WHERE id = ?", [state, first.items[0]!.id]);
      const second = await intakeDelegatedIssue(db, tracker, {
        linearIssueId: "only",
        sessionId: "ses_2",
        taskKey: "second",
      });
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.alreadyExisted).toBe(false);
      expect(second.items).toHaveLength(1);
      expect(second.items[0]?.state).toBe("queued");
      expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
      expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM work_item").get()?.n).toBe(2);
      db.close();
    },
  );

  test("beforeAdmit cancels the previous item before the replacement is inserted", async () => {
    const db = tempDb();
    const tracker = createFakeTracker([
      {
        linearIssueId: "only",
        identifier: "ENG-9",
        title: "Fix the header",
        description: null,
        subIssues: [],
      },
    ]);
    const first = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "only",
      sessionId: "ses_1",
      taskKey: "first",
    });
    if (!first.ok) throw new Error("expected intake");
    let activeBefore = -1;
    const second = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "only",
      sessionId: "ses_1",
      taskKey: "second",
      beforeAdmit: () => {
        activeBefore = db
          .query<{ n: number }, []>(
            "SELECT COUNT(*) AS n FROM work_item WHERE state NOT IN ('completed', 'merged', 'cancelled')",
          )
          .get()!.n;
        db.run("UPDATE work_item SET state = 'cancelled' WHERE id = ?", [first.items[0]!.id]);
      },
    });
    expect(activeBefore).toBe(1);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(
      db
        .query<{ state: string }, [string]>("SELECT state FROM work_item WHERE id = ?")
        .get(first.items[0]!.id)?.state,
    ).toBe("cancelled");
    expect(second.items[0]?.state).toBe("queued");
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM work_item").get()?.n).toBe(2);
    db.close();
  });

  test("a repeated delegation of the same issue replays without an epic row", async () => {
    const db = tempDb();
    const tracker = createFakeTracker([
      {
        linearIssueId: "only",
        identifier: "ENG-9",
        title: "Fix the header",
        description: null,
        subIssues: [],
      },
    ]);
    const result = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "only",
      sessionId: "ses_9",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.delegation.state).toBe("running");
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'epic'").all(),
    ).toEqual([]);
    const again = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "only",
      sessionId: "ses_9",
    });
    expect(again.ok && again.alreadyExisted).toBe(true);
    if (!again.ok) return;
    expect(again.delegation.id).toBe(result.delegation.id);
    expect(again.items.map((item) => item.id)).toEqual(result.items.map((item) => item.id));
    expect(tracker.progress).toHaveLength(1);
    db.run("UPDATE work_item SET state = 'cancelled'");
    const cancelled = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "only",
      sessionId: "ses_9",
    });
    expect(cancelled.ok && cancelled.delegation.state).toBe("cancelled");
    db.run("UPDATE work_item SET state = 'merged'");
    const done = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "only",
      sessionId: "ses_9",
    });
    expect(done.ok && done.delegation.state).toBe("done");
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'epic'").all(),
    ).toEqual([]);
    db.close();
  });

  test("an adopted parent replays from its project approval", async () => {
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
    db.run("INSERT INTO workspace VALUES('workspace','org','Workspace',1000)");
    db.run(
      "INSERT INTO workspace_user VALUES('person','linear-person','Person','person@example.test')",
    );
    const result = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "parent",
      sessionId: "ses_1",
      taskKey: "parent-task",
      adoptParent: () => {
        db.run(
          `INSERT INTO project_approval(id,workspace_id,project_id,actor_id,lead_user_id,generation,preview,created_at,expires_at,approved_at,source)
           VALUES('approval','workspace','parent','person','person','parent:ses_1','{"project":{"name":"Parent","identifier":"ENG-1"}}',1,1,1,'parent')`,
        );
        return true;
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alreadyExisted).toBe(false);
    expect(result.items).toEqual([]);
    expect(result.delegation).toMatchObject({
      id: "approval",
      linearIssueId: "parent",
      linearIdentifier: "ENG-1",
      title: "Parent",
      state: "done",
    });
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'epic'").all(),
    ).toEqual([]);
    const again = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "parent",
      sessionId: "ses_1",
      taskKey: "parent-followup",
      adoptParent: () => {
        throw new Error("replay must not adopt again");
      },
    });
    expect(again.ok && again.alreadyExisted).toBe(true);
    if (!again.ok) return;
    expect(again.delegation.id).toBe("approval");
    expect(again.items).toEqual([]);
    expect(tracker.progress).toHaveLength(0);
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'epic'").all(),
    ).toEqual([]);
    db.close();
  });

  test("a cycle stores no epic row and reports the cycle again", async () => {
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
    expect(result.delegation.state).toBe("stalled");
    expect(result.alreadyExisted).toBe(false);
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'epic'").all(),
    ).toEqual([]);
    expect(db.query("SELECT id FROM work_item").all()).toEqual([]);
    const again = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "parent",
      sessionId: "ses_1",
    });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.reason).toBe("cycle");
    expect(again.identifiers).toEqual(["ENG-2", "ENG-3"]);
    expect(again.alreadyExisted).toBe(false);
    expect(tracker.progress.map((update) => update.body)).toEqual([
      cycleMessage(["ENG-2", "ENG-3"]),
      cycleMessage(["ENG-2", "ENG-3"]),
    ]);
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'epic'").all(),
    ).toEqual([]);
    db.close();
  });
});
