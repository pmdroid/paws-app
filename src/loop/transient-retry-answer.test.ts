import { expect, test } from "bun:test";
import { FakeClock, JOB_KIND, MAX_TRANSIENT_RETRIES } from "../core";
import {
  applyWorkItemEvent,
  beginImplementRun,
  deferWorkItem,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  migrate,
  openDatabase,
  sqliteDb,
} from "../db";
import { answer } from "../questions";
import { askSteps } from "./operations";
import { questionEffects } from "./question-effects";

test("an answer restarts the task with a fresh transient-retry count", async () => {
  const clock = new FakeClock(20_000);
  const db = openDatabase(":memory:");
  migrate(db);
  const item = insertQueuedItem(db, { id: "acme-7", sessionKey: "ses", now: clock.now() });
  beginImplementRun(db, item.id, clock.now());
  await deferWorkItem(sqliteDb(db), getWorkItem(db, item.id)!, {
    retry: MAX_TRANSIENT_RETRIES,
    delayMs: 0,
    handoff: null,
    message: null,
    now: clock.now(),
  });
  const deferred = listJobs(db).find((job) => job.queue === JOB_KIND.resume)!;
  expect(deferred.payload).toMatchObject({ retry: MAX_TRANSIENT_RETRIES });
  db.run("UPDATE job SET status='done' WHERE id=?", [deferred.id]);
  applyWorkItemEvent(db, item.id, "recovered");
  const running = getWorkItem(db, item.id)!;
  await sqliteDb(db).transaction((q) =>
    askSteps(
      q,
      { itemId: item.id, runId: running.currentRunId, sessionId: "ses" },
      "clarification",
      "Which widget should the acme report count?",
      { now: clock.now() },
    ),
  );
  clock.advance(60_000);
  expect(
    answer(
      db,
      {
        sessionId: "ses",
        deliveryId: "reply:widgets",
        body: "Count blue widgets.",
        answeredBy: "pascal",
        now: clock.now(),
      },
      questionEffects(db, { now: clock.now() }),
    ).status,
  ).toBe("answered");
  expect(getWorkItem(db, item.id)?.state).toBe("queued");
  const restarted = listJobs(db).find(
    (job) => job.queue === JOB_KIND.resume && job.status === "pending",
  )!;
  expect(restarted.payload).toMatchObject({ itemId: item.id, reason: "answer" });
  expect((restarted.payload as { retry?: unknown }).retry).toBeUndefined();
});
