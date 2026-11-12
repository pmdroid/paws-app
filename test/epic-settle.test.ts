import { expect, test } from "bun:test";
import { eq, like, sql } from "drizzle-orm";
import { FakeClock, JOB_KIND } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  bindLinearSessionTask,
  ensureLinearSession,
  getWorkItem,
  listOutbox,
  listJobs,
  saveTaskClassification,
  type Db,
} from "../src/db";
import { intakeDelegatedIssue } from "../src/intake";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { Orchestrator } from "../src/loop";
import { tempHome } from "./helpers";
import { workspaceAdmission } from "./fake-workspace";
import { tempStore } from "./pglite";

async function harness() {
  const { db, close } = await tempStore();
  const clock = new FakeClock(1_000);
  const orchestrator = new Orchestrator({
    store: db,
    admission: workspaceAdmission(db),
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
    clock,
    pawsRoot: tempHome(),
  });
  return { db, close, clock, orchestrator };
}

function seed(db: Db, now: number, id: string, states: readonly string[]): Promise<void> {
  return db.run(function* (q) {
    for (const [index, itemState] of states.entries())
      yield* q.exec(
        q.orm.insert(q.t.workItem).values({
          id: `${id}-${index}`,
          delegationId: id,
          linearIssueId: `${id}-issue-${index}`,
          linearIdentifier: `${id}-${index}`,
          title: id,
          state: itemState,
          branchName: `paws/${id}-${index}`,
          position: index,
          createdAt: now,
          sessionKey: `${id}-session`,
        }),
      );
  });
}

const items = (db: Db, id?: string) =>
  db.run((q) =>
    q.all(
      q.orm
        .select({ linearIssueId: q.t.workItem.linearIssueId, state: q.t.workItem.state })
        .from(q.t.workItem)
        .where(id === undefined ? undefined : eq(q.t.workItem.delegationId, id))
        .orderBy(q.t.workItem.position, q.t.workItem.id),
    ),
  );

const epicTables = (db: Db) =>
  db.run((q) =>
    q.all(
      q.orm
        .select({ name: sql<string>`table_name` })
        .from(sql`information_schema.tables`)
        .where(sql`table_name = 'epic'`),
    ),
  );

const itemStates = async (db: Db, id: string) => (await items(db, id)).map((row) => row.state);

async function summaryActivities(db: Db): Promise<number> {
  return (await listOutbox(db)).filter((row) => {
    const body = JSON.stringify(row.payload);
    return (
      row.idempotencyKey.startsWith("epic-done:") ||
      body.includes("Epic complete") ||
      body.includes("Epic abandoned")
    );
  }).length;
}

test("when a delegation's only item merges, that item stays merged and no delegation summary activity is enqueued", async () => {
  const { db, close, clock, orchestrator } = await harness();
  try {
    await seed(db, clock.now(), "merged", ["merged"]);
    await orchestrator.reconcileExecution();
    expect(await itemStates(db, "merged")).toEqual(["merged"]);
    expect(await summaryActivities(db)).toBe(0);
  } finally {
    await orchestrator.shutdown();
    await close();
  }
});

test("when every item is cancelled, those items stay cancelled", async () => {
  const { db, close, clock, orchestrator } = await harness();
  try {
    await seed(db, clock.now(), "cancelled", ["cancelled", "cancelled"]);
    await orchestrator.reconcileExecution();
    expect(await itemStates(db, "cancelled")).toEqual(["cancelled", "cancelled"]);
  } finally {
    await orchestrator.shutdown();
    await close();
  }
});

test("a held item no longer produces a stall question after ten minutes", async () => {
  const { db, close, clock, orchestrator } = await harness();
  try {
    await seed(db, clock.now(), "held", ["failed"]);
    await orchestrator.reconcileExecution();
    clock.advance(10 * 60 * 1000);
    await orchestrator.reconcileExecution();
    const questions = (
      await db.run((q) =>
        q.all(
          q.orm
            .select({ id: q.t.question.id })
            .from(q.t.question)
            .where(like(q.t.question.body, "%made no progress%")),
        ),
      )
    ).length;
    const notices = (await listOutbox(db)).filter((row) =>
      JSON.stringify(row.payload).includes("made no progress"),
    ).length;
    expect(await itemStates(db, "held")).toEqual(["failed"]);
    expect(questions).toBe(0);
    expect(notices).toBe(0);
  } finally {
    await orchestrator.shutdown();
    await close();
  }
});

test("the orchestrator pump treats a delegation whose items are all merged as finished without reading the epic table", async () => {
  const { db, close } = await tempStore();
  const clock = new FakeClock(1_000);
  const orchestrator = new Orchestrator({
    store: db,
    admission: workspaceAdmission(db),
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
    await db.run((q) =>
      q.exec(
        q.orm
          .update(q.t.workItem)
          .set({ state: "merged" })
          .where(eq(q.t.workItem.delegationId, finished.delegation.id)),
      ),
    );
    expect(await epicTables(db)).toEqual([]);
    await orchestrator.reconcileExecution();
    expect((await getWorkItem(db, finished.items[0]!.id))?.state).toBe("merged");
    expect(
      (await listJobs(db))
        .filter((job) => job.queue === JOB_KIND.start && job.status === "pending")
        .map((job) => job.payload),
    ).toEqual([{ itemId: open.items[0]!.id }]);
  } finally {
    await orchestrator.shutdown();
    await close();
  }
});

test("a follow-up session turn routes by the item's task key without the epic row", async () => {
  const { db, close } = await tempStore();
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
    store: db,
    admission: workspaceAdmission(db),
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
    await ensureLinearSession(db, {
      sessionId: "session",
      issueId: "parent",
      creatorId: "human",
      now: clock.now(),
    });
    await bindLinearSessionTask(db, "session", intake.delegation.id, {
      actorId: "human",
    });
    await saveTaskClassification(db, "session:session", {
      mode: "code",
      redirect: { taskKey: "resolved:session:session", itemId: parentId },
    });
    await saveTaskClassification(db, "resolved:session:session", {
      mode: "code",
      context: "Build the child issue.",
      sourceItemId: parentId,
    });
    tracker.epics.set("parent", {
      ...tracker.epics.get("parent")!,
      subIssues: [{ linearIssueId: "child", identifier: "ENG-2", title: "Child" }],
    });
    expect(await epicTables(db)).toEqual([]);
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
      (await items(db)).sort((a, b) => a.linearIssueId.localeCompare(b.linearIssueId)),
    ).toEqual([
      { linearIssueId: "child", state: "queued" },
      { linearIssueId: "parent", state: "cancelled" },
    ]);
  } finally {
    await orchestrator.shutdown();
    await close();
  }
});
