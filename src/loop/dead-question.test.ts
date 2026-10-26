import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { JOB_KIND } from "../core";
import {
  beginImplementRun,
  enqueueJob,
  getJob,
  getWorkItem,
  insertQueuedItem,
  listDeadDeliveries,
  listOutbox,
  migrate,
  openDatabase,
} from "../db";
import { findOpenQuestion, getQuestion, getVisualReview } from "../questions";
import { reaskDeadQuestion } from "./dead-question";
import { ask } from "./operations";

const open: Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function waitingItem(kind: "agent" | "visual-review" = "agent") {
  const db = openDatabase(":memory:");
  migrate(db);
  open.push(db);
  insertQueuedItem(db, { id: "item-q", sessionKey: "ses-q", now: 0 });
  beginImplementRun(db, "item-q", 1_000);
  const item = getWorkItem(db, "item-q")!;
  const asked = ask(
    db,
    { itemId: item.id, runId: item.currentRunId, sessionId: "ses-q", version: item.version },
    kind,
    "Which repository?",
    { options: ["paws-app", "paws-runner"], now: 2_000 },
  );
  if (kind === "visual-review")
    db.run(
      `INSERT INTO visual_review (question_id, item_id, check_id, evidence_ids, created_at)
       VALUES (?, 'item-q', 'visual-proof', '[]', 2000)`,
      [asked.question.id],
    );
  // Both deliveries of the elicitation used their attempts.
  db.run("UPDATE outbox SET status = 'dead', error = 'Linear is down' WHERE op = 'elicitation'");
  const job = enqueueJob(db, {
    queue: JOB_KIND.reaskQuestion,
    jobKey: `${JOB_KIND.reaskQuestion}:${asked.question.id}`,
    payload: { itemId: "item-q", questionId: asked.question.id },
    now: 2_500,
  });
  return { db, question: asked.question, job };
}

describe("a question whose elicitation died twice", () => {
  test("is asked again through ask() with a fresh delivery", () => {
    const { db, question, job } = waitingItem();
    expect(getWorkItem(db, "item-q")?.state).toBe("awaiting_input");
    expect(listDeadDeliveries(db, "item-q")).toHaveLength(1);

    const again = reaskDeadQuestion(db, {
      itemId: "item-q",
      questionId: question.id,
      jobId: job,
      now: 3_000,
    });

    expect(again).not.toBeNull();
    expect(again).not.toBe(question.id);
    expect(getQuestion(db, again!)).toMatchObject({
      body: "Which repository?",
      options: ["paws-app", "paws-runner"],
      kind: "agent",
    });
    expect(getQuestion(db, question.id)?.cancelledAt).toBe(3_000);
    expect(findOpenQuestion(db, "ses-q")?.id).toBe(again!);
    expect(getWorkItem(db, "item-q")?.state).toBe("awaiting_input");
    expect(listOutbox(db, "ses-q").map((row) => [row.idempotencyKey, row.status])).toEqual([
      [`question:${question.id}`, "dropped"],
      [`question:${again}`, "pending"],
    ]);
    expect(listDeadDeliveries(db, "item-q")).toEqual([]);
    // The job remembers the question it produced, so that question shares this allowance.
    expect(getJob(db, job)?.payload).toMatchObject({ questionId: question.id, reaskedAs: again });
  });

  test("a visual review keeps its question and review, and is delivered again", () => {
    const { db, question, job } = waitingItem("visual-review");

    const again = reaskDeadQuestion(db, {
      itemId: "item-q",
      questionId: question.id,
      jobId: job,
      now: 3_000,
    });

    expect(again).toBe(question.id);
    expect(getQuestion(db, question.id)?.status).toBe("open");
    expect(findOpenQuestion(db, "ses-q")?.id).toBe(question.id);
    expect(getVisualReview(db, question.id)).not.toBeNull();
    expect(listOutbox(db, "ses-q").map((row) => [row.idempotencyKey, row.status])).toEqual([
      [`question:${question.id}`, "dropped"],
      [`question:${question.id}:reask`, "pending"],
    ]);
    expect(listOutbox(db, "ses-q")[1]?.payload).toEqual(listOutbox(db, "ses-q")[0]?.payload);
    expect(listDeadDeliveries(db, "item-q")).toEqual([]);
    expect(getJob(db, job)?.payload).toMatchObject({ reaskedAs: question.id });
  });

  test("changes nothing once the item stopped waiting or the question was answered", () => {
    const moved = waitingItem();
    moved.db.run("UPDATE work_item SET state = 'running' WHERE id = 'item-q'");
    expect(
      reaskDeadQuestion(moved.db, {
        itemId: "item-q",
        questionId: moved.question.id,
        jobId: moved.job,
        now: 3_000,
      }),
    ).toBeNull();
    expect(listDeadDeliveries(moved.db, "item-q")).toHaveLength(1);

    const answered = waitingItem();
    answered.db.run("UPDATE question SET status = 'answered' WHERE id = ?", [answered.question.id]);
    expect(
      reaskDeadQuestion(answered.db, {
        itemId: "item-q",
        questionId: answered.question.id,
        jobId: answered.job,
        now: 3_000,
      }),
    ).toBeNull();
    expect(listOutbox(answered.db, "ses-q").filter((row) => row.op === "elicitation")).toHaveLength(
      1,
    );
  });
});
