import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { FakeClock, JOB_KIND, MAX_TRANSIENT_RETRIES } from "../core";
import {
  applyWorkItemEvent,
  beginImplementRun,
  deferWorkItem,
  getWorkItem,
  insertQueuedItem,
  listJobs,
} from "../db";
import { answerSteps } from "../questions";
import { askSteps } from "./operations";
import { questionEffects } from "./question-effects";
import { seed } from "../../test/dialects";
import { tempStore } from "../../test/pglite";

const open: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

test("an answer restarts the task with a fresh transient-retry count", async () => {
  const clock = new FakeClock(20_000);
  const { db, close } = await tempStore();
  open.push(close);
  const item = await insertQueuedItem(db, { id: "acme-7", sessionKey: "ses", now: clock.now() });
  await beginImplementRun(db, item.id, clock.now());
  await deferWorkItem(db, (await getWorkItem(db, item.id))!, {
    retry: MAX_TRANSIENT_RETRIES,
    delayMs: 0,
    handoff: null,
    message: null,
    now: clock.now(),
  });
  const deferred = (await listJobs(db)).find((job) => job.queue === JOB_KIND.resume)!;
  expect(deferred.payload).toMatchObject({ retry: MAX_TRANSIENT_RETRIES });
  await seed(db, (q) =>
    q.orm.update(q.t.job).set({ status: "done" }).where(eq(q.t.job.id, deferred.id)),
  );
  await applyWorkItemEvent(db, item.id, "recovered");
  const running = (await getWorkItem(db, item.id))!;
  await db.transaction((q) =>
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
    (
      await db.transaction((q) =>
        answerSteps(
          q,
          {
            sessionId: "ses",
            deliveryId: "reply:widgets",
            body: "Count blue widgets.",
            answeredBy: "pascal",
            now: clock.now(),
          },
          questionEffects(db, { now: clock.now() }),
        ),
      )
    ).status,
  ).toBe("answered");
  expect((await getWorkItem(db, item.id))?.state).toBe("queued");
  const restarted = (await listJobs(db)).find(
    (job) => job.queue === JOB_KIND.resume && job.status === "pending",
  )!;
  expect(restarted.payload).toMatchObject({ itemId: item.id, reason: "answer" });
  expect((restarted.payload as { retry?: unknown }).retry).toBeUndefined();
});
