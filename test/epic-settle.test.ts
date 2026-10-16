import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { FakeClock } from "../src/core";
import { JobLoop, OutboxDispatcher, listOutbox } from "../src/db";
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
  db.run(
    "INSERT INTO epic(id,linear_issue_id,linear_identifier,title,state,created_at) VALUES(?,?,?,?,?,?)",
    [id, `${id}-parent`, id, id, "running", now],
  );
  states.forEach((itemState, index) =>
    db.run(
      "INSERT INTO work_item(id,epic_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at,session_key) VALUES(?,?,?,?,?,?,?,?,?,?)",
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

function epicState(db: Database, id: string): string | undefined {
  return db.query<{ state: string }, [string]>("SELECT state FROM epic WHERE id=?").get(id)?.state;
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

test("when an epic's only item merges, the epic row becomes done and no epic summary activity is enqueued", async () => {
  const { db, clock, orchestrator } = harness();
  try {
    seed(db, clock.now(), "merged", ["merged"]);
    orchestrator.reconcileExecution();
    expect(epicState(db, "merged")).toBe("done");
    expect(summaryActivities(db)).toBe(0);
  } finally {
    await orchestrator.shutdown();
    db.close();
  }
});

test("when every item is cancelled, the epic becomes cancelled", async () => {
  const { db, clock, orchestrator } = harness();
  try {
    seed(db, clock.now(), "cancelled", ["cancelled", "cancelled"]);
    orchestrator.reconcileExecution();
    expect(epicState(db, "cancelled")).toBe("cancelled");
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
    expect(epicState(db, "held")).toBe("running");
    expect(questions).toBe(0);
    expect(notices).toBe(0);
  } finally {
    await orchestrator.shutdown();
    db.close();
  }
});
