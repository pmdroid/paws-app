import { expect, test } from "bun:test";
import { FakeClock } from "../src/core";
import { enqueueOutbox, OutboxDispatcher } from "../src/db";
import { createFakeTracker } from "../src/linear";
import { createLinearSessionProgress, deliverLinearOutbox } from "../src/loop";
import { tempDb } from "./helpers";

function harness() {
  const db = tempDb();
  const clock = new FakeClock(1_000_000);
  const tracker = createFakeTracker();
  const dispatcher = new OutboxDispatcher(db, clock);
  dispatcher.setHandler((row, context) =>
    deliverLinearOutbox(row, tracker, async () => {}, context, db),
  );
  const flush = async () => {
    while (dispatcher.tick().length > 0) await dispatcher.idle();
  };
  const requests = () =>
    tracker.progress.length + tracker.questions.length + tracker.sessionUpdates.length;
  let key = 0;
  const activity = (payload: Record<string, unknown>) =>
    enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      orderingKey: "session",
      idempotencyKey: `activity:${++key}`,
      payload: { sessionId: "session", ...payload },
      now: clock.now(),
    });
  return { db, clock, tracker, dispatcher, flush, requests, activity };
}

test("a run producing 50 progress events in a minute sends at most a few Linear requests", async () => {
  const { db, clock, tracker, flush, requests, activity } = harness();
  const progress = createLinearSessionProgress(db, "session", "ENG-1", () => clock.now());
  for (let index = 0; index < 50; index++) {
    if (index % 5 === 4) {
      activity({ kind: "thought", body: `Working ${index}`, ephemeral: true });
    } else if (index % 7 === 3) {
      progress.plan([{ content: `Step ${index}`, status: "inProgress" }]);
      progress.phase(index % 2 === 0 ? "implementing" : "verifying");
    } else {
      activity({ kind: "thought", body: `Thought ${index}` });
    }
    await flush();
    clock.advance(1_200);
  }
  clock.advance(120_000);
  await flush();
  expect(requests()).toBeLessThanOrEqual(8);
  const bodies = tracker.progress.map((update) => update.body).join("\n");
  for (let index = 0; index < 50; index++) {
    if (index % 5 !== 4 && index % 7 !== 3) expect(bodies).toContain(`Thought ${index}`);
  }
  expect(tracker.sessionUpdates.at(-1)?.plan?.[0]?.content).toBe("Step 45");
  db.close();
});

test("questions, errors and links go out at once and keep their order", async () => {
  const { db, clock, tracker, flush, activity } = harness();
  activity({ kind: "thought", body: "First" });
  await flush();
  activity({ kind: "thought", body: "Second" });
  enqueueOutbox(db, {
    target: "linear",
    op: "elicitation",
    orderingKey: "session",
    idempotencyKey: "question",
    payload: { sessionId: "session", body: "Which one?" },
    now: clock.now(),
  });
  await flush();
  expect(tracker.progress.map((update) => update.body)).toEqual(["First", "Second"]);
  expect(tracker.questions.map((question) => question.body)).toEqual(["Which one?"]);
  activity({ kind: "thought", body: "Third" });
  activity({ kind: "error", body: "Failed" });
  await flush();
  expect(tracker.progress.map((update) => update.body)).toEqual([
    "First",
    "Second",
    "Third",
    "Failed",
  ]);
  db.close();
});

test("pending plan, summary and links for one session go out as one update", async () => {
  const { db, clock, tracker, flush } = harness();
  const progress = createLinearSessionProgress(db, "session", "ENG-1", () => clock.now());
  progress.plan([{ content: "Build", status: "inProgress" }]);
  await flush();
  progress.plan([{ content: "Build", status: "completed" }]);
  progress.status("ENG-1: verifying");
  progress.link("Pull request", "https://github.com/acme/app/pull/1");
  progress.link("Run", "https://paws.example/run/1");
  await flush();
  expect(tracker.sessionUpdates).toHaveLength(2);
  expect(tracker.sessionUpdates[1]).toEqual({
    sessionId: "session",
    plan: [
      { content: "Build", status: "completed" },
      { content: "Verify changes", status: "pending" },
      { content: "Open pull request", status: "pending" },
      { content: "Merge verified changes", status: "pending" },
    ],
    summary: "ENG-1: verifying",
    addedExternalUrls: [
      { label: "Pull request", url: "https://github.com/acme/app/pull/1" },
      { label: "Run", url: "https://paws.example/run/1" },
    ],
  });
  progress.phase("merging");
  await flush();
  expect(tracker.sessionUpdates).toHaveLength(2);
  clock.advance(120_000);
  await flush();
  expect(tracker.sessionUpdates).toHaveLength(3);
  expect(tracker.sessionUpdates[2]?.summary).toBe("ENG-1: merging");
  db.close();
});
