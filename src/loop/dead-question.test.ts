import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { JOB_KIND } from "../core";
import {
  sqliteDb,
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
import { askSteps } from "./operations";

const open: Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

async function waitingItem(kind: "agent" | "visual-review" = "agent") {
  const db = openDatabase(":memory:");
  migrate(db);
  open.push(db);
  insertQueuedItem(db, { id: "item-q", sessionKey: "ses-q", now: 0 });
  await beginImplementRun(sqliteDb(db), "item-q", 1_000);
  const item = getWorkItem(db, "item-q")!;
  const asked = await sqliteDb(db).transaction((q) =>
    askSteps(
      q,
      { itemId: item.id, runId: item.currentRunId, sessionId: "ses-q", version: item.version },
      kind,
      "Which repository?",
      { options: ["paws-app", "paws-runner"], now: 2_000 },
    ),
  );
  if (kind === "visual-review")
    db.run(
      `INSERT INTO visual_review (question_id, item_id, check_id, evidence_ids, created_at)
       VALUES (?, 'item-q', 'visual-proof', '[]', 2000)`,
      [asked.question.id],
    );
  // Both deliveries of the elicitation used their attempts.
  db.run("UPDATE outbox SET status = 'dead', error = 'Linear is down' WHERE op = 'elicitation'");
  const job = await enqueueJob(sqliteDb(db), {
    queue: JOB_KIND.reaskQuestion,
    jobKey: `${JOB_KIND.reaskQuestion}:${asked.question.id}`,
    payload: { itemId: "item-q", questionId: asked.question.id },
    now: 2_500,
  });
  return { db, question: asked.question, job };
}

describe("a question whose elicitation died twice", () => {
  test("is asked again through ask() with a fresh delivery", async () => {
    const { db, question, job } = await waitingItem();
    expect(getWorkItem(db, "item-q")?.state).toBe("awaiting_input");
    expect(await listDeadDeliveries(sqliteDb(db), "item-q")).toHaveLength(1);

    const again = await reaskDeadQuestion(sqliteDb(db), {
      itemId: "item-q",
      questionId: question.id,
      jobId: job,
      now: 3_000,
    });

    expect(again).not.toBeNull();
    expect(again).not.toBe(question.id);
    expect(await getQuestion(sqliteDb(db), again!)).toMatchObject({
      body: "Which repository?",
      options: ["paws-app", "paws-runner"],
      kind: "agent",
    });
    expect((await getQuestion(sqliteDb(db), question.id))?.cancelledAt).toBe(3_000);
    expect(findOpenQuestion(db, "ses-q")?.id).toBe(again!);
    expect(getWorkItem(db, "item-q")?.state).toBe("awaiting_input");
    expect(
      (await listOutbox(sqliteDb(db), "ses-q")).map((row) => [row.idempotencyKey, row.status]),
    ).toEqual([
      [`question:${question.id}`, "dropped"],
      [`question:${again}`, "pending"],
    ]);
    expect(await listDeadDeliveries(sqliteDb(db), "item-q")).toEqual([]);
    // The job remembers the question it produced, so that question shares this allowance.
    expect((await getJob(sqliteDb(db), job))?.payload).toMatchObject({
      questionId: question.id,
      reaskedAs: again,
    });
  });

  test("a visual review keeps its question and review, and is delivered again", async () => {
    const { db, question, job } = await waitingItem("visual-review");

    const again = await reaskDeadQuestion(sqliteDb(db), {
      itemId: "item-q",
      questionId: question.id,
      jobId: job,
      now: 3_000,
    });

    expect(again).toBe(question.id);
    expect((await getQuestion(sqliteDb(db), question.id))?.status).toBe("open");
    expect(findOpenQuestion(db, "ses-q")?.id).toBe(question.id);
    expect(await getVisualReview(sqliteDb(db), question.id)).not.toBeNull();
    expect(
      (await listOutbox(sqliteDb(db), "ses-q")).map((row) => [row.idempotencyKey, row.status]),
    ).toEqual([
      [`question:${question.id}`, "dropped"],
      [`question:${question.id}:reask`, "pending"],
    ]);
    expect((await listOutbox(sqliteDb(db), "ses-q"))[1]?.payload).toEqual(
      (await listOutbox(sqliteDb(db), "ses-q"))[0]?.payload,
    );
    expect(await listDeadDeliveries(sqliteDb(db), "item-q")).toEqual([]);
    expect((await getJob(sqliteDb(db), job))?.payload).toMatchObject({ reaskedAs: question.id });
  });

  test("changes nothing once the item stopped waiting or the question was answered", async () => {
    const moved = await waitingItem();
    moved.db.run("UPDATE work_item SET state = 'running' WHERE id = 'item-q'");
    expect(
      await reaskDeadQuestion(sqliteDb(moved.db), {
        itemId: "item-q",
        questionId: moved.question.id,
        jobId: moved.job,
        now: 3_000,
      }),
    ).toBeNull();
    expect(await listDeadDeliveries(sqliteDb(moved.db), "item-q")).toHaveLength(1);

    const answered = await waitingItem();
    answered.db.run("UPDATE question SET status = 'answered' WHERE id = ?", [answered.question.id]);
    expect(
      await reaskDeadQuestion(sqliteDb(answered.db), {
        itemId: "item-q",
        questionId: answered.question.id,
        jobId: answered.job,
        now: 3_000,
      }),
    ).toBeNull();
    expect(
      (await listOutbox(sqliteDb(answered.db), "ses-q")).filter((row) => row.op === "elicitation"),
    ).toHaveLength(1);
  });
});
