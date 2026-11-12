import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { JOB_KIND } from "../core";
import {
  beginImplementRun,
  enqueueJob,
  getJob,
  getWorkItem,
  insertQueuedItem,
  listDeadDeliveries,
  listOutbox,
} from "../db";
import { findOpenQuestion, getQuestion, getVisualReview } from "../questions";
import { reaskDeadQuestion } from "./dead-question";
import { askSteps } from "./operations";
import { seed } from "../../test/dialects";
import { tempStore } from "../../test/pglite";

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

async function waitingItem(kind: "agent" | "visual-review" = "agent") {
  const { db, close } = await tempStore();
  open.push(close);
  await insertQueuedItem(db, { id: "item-q", sessionKey: "ses-q", now: 0 });
  await beginImplementRun(db, "item-q", 1_000);
  const item = (await getWorkItem(db, "item-q"))!;
  const asked = await db.transaction((q) =>
    askSteps(
      q,
      { itemId: item.id, runId: item.currentRunId, sessionId: "ses-q", version: item.version },
      kind,
      "Which repository?",
      { options: ["paws-app", "paws-runner"], now: 2_000 },
    ),
  );
  if (kind === "visual-review")
    await seed(db, (q) =>
      q.orm.insert(q.t.visualReview).values({
        questionId: asked.question.id,
        itemId: "item-q",
        checkId: "visual-proof",
        evidenceIds: [],
        createdAt: 2000,
      }),
    );
  // Both deliveries of the elicitation used their attempts.
  await seed(db, (q) =>
    q.orm
      .update(q.t.outbox)
      .set({ status: "dead", error: "Linear is down" })
      .where(eq(q.t.outbox.op, "elicitation")),
  );
  const job = await enqueueJob(db, {
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
    expect((await getWorkItem(db, "item-q"))?.state).toBe("awaiting_input");
    expect(await listDeadDeliveries(db, "item-q")).toHaveLength(1);

    const again = await reaskDeadQuestion(db, {
      itemId: "item-q",
      questionId: question.id,
      jobId: job,
      now: 3_000,
    });

    expect(again).not.toBeNull();
    expect(again).not.toBe(question.id);
    expect(await getQuestion(db, again!)).toMatchObject({
      body: "Which repository?",
      options: ["paws-app", "paws-runner"],
      kind: "agent",
    });
    expect((await getQuestion(db, question.id))?.cancelledAt).toBe(3_000);
    expect((await findOpenQuestion(db, "ses-q"))?.id).toBe(again!);
    expect((await getWorkItem(db, "item-q"))?.state).toBe("awaiting_input");
    expect((await listOutbox(db, "ses-q")).map((row) => [row.idempotencyKey, row.status])).toEqual([
      [`question:${question.id}`, "dropped"],
      [`question:${again}`, "pending"],
    ]);
    expect(await listDeadDeliveries(db, "item-q")).toEqual([]);
    // The job remembers the question it produced, so that question shares this allowance.
    expect((await getJob(db, job))?.payload).toMatchObject({
      questionId: question.id,
      reaskedAs: again,
    });
  });

  test("a visual review keeps its question and review, and is delivered again", async () => {
    const { db, question, job } = await waitingItem("visual-review");

    const again = await reaskDeadQuestion(db, {
      itemId: "item-q",
      questionId: question.id,
      jobId: job,
      now: 3_000,
    });

    expect(again).toBe(question.id);
    expect((await getQuestion(db, question.id))?.status).toBe("open");
    expect((await findOpenQuestion(db, "ses-q"))?.id).toBe(question.id);
    expect(await getVisualReview(db, question.id)).not.toBeNull();
    expect((await listOutbox(db, "ses-q")).map((row) => [row.idempotencyKey, row.status])).toEqual([
      [`question:${question.id}`, "dropped"],
      [`question:${question.id}:reask`, "pending"],
    ]);
    expect((await listOutbox(db, "ses-q"))[1]?.payload).toEqual(
      (await listOutbox(db, "ses-q"))[0]?.payload,
    );
    expect(await listDeadDeliveries(db, "item-q")).toEqual([]);
    expect((await getJob(db, job))?.payload).toMatchObject({ reaskedAs: question.id });
  });

  test("changes nothing once the item stopped waiting or the question was answered", async () => {
    const moved = await waitingItem();
    await seed(moved.db, (q) =>
      q.orm.update(q.t.workItem).set({ state: "running" }).where(eq(q.t.workItem.id, "item-q")),
    );
    expect(
      await reaskDeadQuestion(moved.db, {
        itemId: "item-q",
        questionId: moved.question.id,
        jobId: moved.job,
        now: 3_000,
      }),
    ).toBeNull();
    expect(await listDeadDeliveries(moved.db, "item-q")).toHaveLength(1);

    const answered = await waitingItem();
    await seed(answered.db, (q) =>
      q.orm
        .update(q.t.question)
        .set({ status: "answered" })
        .where(eq(q.t.question.id, answered.question.id)),
    );
    expect(
      await reaskDeadQuestion(answered.db, {
        itemId: "item-q",
        questionId: answered.question.id,
        jobId: answered.job,
        now: 3_000,
      }),
    ).toBeNull();
    expect(
      (await listOutbox(answered.db, "ses-q")).filter((row) => row.op === "elicitation"),
    ).toHaveLength(1);
  });
});
