import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { FakeClock, JOB_KIND } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  bindLinearSessionTask,
  ensureLinearSession,
  getWorkItem,
  listOutbox,
  saveTaskClassification,
} from "../src/db";
import { intakeDelegatedIssue } from "../src/intake";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { Orchestrator } from "../src/loop";
import { tempDb, tempHome } from "./helpers";

function harness() {
  const db = tempDb();
  const clock = new FakeClock(1_000);
  const orchestrator = new Orchestrator({
    db,
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
    clock,
    pawsRoot: tempHome(),
  });
  return { db, clock, orchestrator };
}

function seed(db: Database, now: number, id: string, states: readonly string[]): void {
  states.forEach((itemState, index) =>
    db.run(
      "INSERT INTO work_item(id,delegation_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at,session_key) VALUES(?,?,?,?,?,?,?,?,?,?)",
      [
        `${id}-${index}`,
        id,
        `${id}-issue-${index}`,
        `${id}-${index}`,
        id,
        itemState,
        `paws/${id}-${index}`,
        index,
        now,
        `${id}-session`,
      ],
    ),
  );
}

function itemStates(db: Database, id: string): string[] {
  return db
    .query<{ state: string }, [string]>(
      "SELECT state FROM work_item WHERE delegation_id=? ORDER BY position, id",
    )
    .all(id)
    .map((row) => row.state);
}

function summaryActivities(db: Database): number {
  return listOutbox(db).filter((row) => {
    const body = JSON.stringify(row.payload);
    return (
      row.idempotencyKey.startsWith("epic-done:") ||
      body.includes("Epic complete") ||
      body.includes("Epic abandoned")
    );
  }).length;
}

test("when an epic's only item merges, that item stays merged and no epic summary activity is enqueued", async () => {
  const { db, clock, orchestrator } = harness();
  try {
    seed(db, clock.now(), "merged", ["merged"]);
    orchestrator.reconcileExecution();
    expect(itemStates(db, "merged")).toEqual(["merged"]);
    expect(summaryActivities(db)).toBe(0);
  } finally {
    await orchestrator.shutdown();
    db.close();
  }
});

test("when every item is cancelled, those items stay cancelled", async () => {
  const { db, clock, orchestrator } = harness();
  try {
    seed(db, clock.now(), "cancelled", ["cancelled", "cancelled"]);
    orchestrator.reconcileExecution();
    expect(itemStates(db, "cancelled")).toEqual(["cancelled", "cancelled"]);
  } finally {
    await orchestrator.shutdown();
    db.close();
  }
});

test("a held item no longer produces a stall question after ten minutes", async () => {
  const { db, clock, orchestrator } = harness();
  try {
    seed(db, clock.now(), "held", ["failed"]);
    orchestrator.reconcileExecution();
    clock.advance(10 * 60 * 1000);
    orchestrator.reconcileExecution();
    const questions = db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM question WHERE body LIKE '%made no progress%'",
      )
      .get()!.n;
    const notices = listOutbox(db).filter((row) =>
      JSON.stringify(row.payload).includes("made no progress"),
    ).length;
    expect(itemStates(db, "held")).toEqual(["failed"]);
    expect(questions).toBe(0);
    expect(notices).toBe(0);
  } finally {
    await orchestrator.shutdown();
    db.close();
  }
});

test("the orchestrator pump treats a delegation whose items are all merged as finished without reading the epic table", async () => {
  const db = tempDb();
  const clock = new FakeClock(1_000);
  const orchestrator = new Orchestrator({
    db,
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
    clock,
    pawsRoot: tempHome(),
  });
  const tracker = createFakeTracker([
    {
      linearIssueId: "finished-issue",
      identifier: "FIN-1",
      title: "Finished",
      description: null,
      subIssues: [],
    },
    {
      linearIssueId: "open-issue",
      identifier: "OPEN-1",
      title: "Open",
      description: null,
      subIssues: [],
    },
  ]);
  try {
    const finished = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "finished-issue",
      now: clock.now(),
    });
    const open = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "open-issue",
      now: clock.now(),
    });
    expect(finished.ok).toBe(true);
    expect(open.ok).toBe(true);
    if (!finished.ok || !open.ok) return;
    db.run("UPDATE work_item SET state = 'merged' WHERE delegation_id = ?", [finished.epic.id]);
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'epic'").get(),
    ).toBeNull();
    orchestrator.reconcileExecution();
    expect(getWorkItem(db, finished.items[0]!.id)?.state).toBe("merged");
    expect(
      db
        .query<{ itemId: string }, [string]>(
          "SELECT json_extract(payload, '$.itemId') AS itemId FROM job WHERE queue = ? AND status = 'pending'",
        )
        .all(JOB_KIND.start),
    ).toEqual([{ itemId: open.items[0]!.id }]);
  } finally {
    await orchestrator.shutdown();
    db.close();
  }
});

test("a follow-up session turn routes by the item's task key without the epic row", async () => {
  const db = tempDb();
  const clock = new FakeClock(1_000);
  const tracker = createFakeTracker([
    {
      linearIssueId: "parent",
      identifier: "ENG-1",
      title: "Parent",
      description: null,
      subIssues: [],
    },
  ]);
  const jobs = new JobLoop(db, clock);
  const orchestrator = new Orchestrator({
    db,
    jobs,
    outbox: new OutboxDispatcher(db, clock),
    clock,
    pawsRoot: tempHome(),
    tracker,
    linearTaskModes: true,
    launch: () => {
      throw new Error("task routing launched an agent");
    },
  });
  try {
    const intake = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "parent",
      sessionId: "session",
      taskKey: "session:session",
      now: clock.now(),
    });
    expect(intake.ok).toBe(true);
    if (!intake.ok) return;
    const parentId = intake.items[0]!.id;
    ensureLinearSession(db, {
      sessionId: "session",
      issueId: "parent",
      creatorId: "human",
      now: clock.now(),
    });
    bindLinearSessionTask(db, "session", intake.epic.id, { actorId: "human" });
    saveTaskClassification(db, "session:session", {
      mode: "code",
      redirect: { taskKey: "resolved:session:session", itemId: parentId },
    });
    saveTaskClassification(db, "resolved:session:session", {
      mode: "code",
      context: "Build the child issue.",
      sourceItemId: parentId,
    });
    tracker.epics.set("parent", {
      ...tracker.epics.get("parent")!,
      subIssues: [{ linearIssueId: "child", identifier: "ENG-2", title: "Child" }],
    });
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'epic'").get(),
    ).toBeNull();
    const followup: AcceptedLinearEvent = {
      dedupeKey: "follow-up",
      deliveryId: null,
      source: "webhook",
      action: "prompted",
      sessionId: "session",
      issueId: "parent",
      activityId: "follow-up",
      actorId: "human",
      body: "Build the child issue.",
      signal: null,
      updatedAtMs: clock.now(),
      payload: JSON.stringify({ agentSession: { creatorId: "human" } }),
    };
    await orchestrator.onLinearEvent(followup);
    await jobs.tick();
    expect(
      db
        .query<{ linear_issue_id: string; state: string }, []>(
          "SELECT linear_issue_id, state FROM work_item ORDER BY linear_issue_id",
        )
        .all(),
    ).toEqual([
      { linear_issue_id: "child", state: "queued" },
      { linear_issue_id: "parent", state: "cancelled" },
    ]);
  } finally {
    await orchestrator.shutdown();
    db.close();
  }
});
