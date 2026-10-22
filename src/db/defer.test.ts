import { expect, test } from "bun:test";
import { JOB_KIND } from "../core";
import {
  beginImplementRun,
  deferWorkItem,
  getRun,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  listOutbox,
  migrate,
  openDatabase,
  setJournalSink,
} from "./index";

test("deferring a running item loses its run, moves it to recovering, and schedules a resume", () => {
  const db = openDatabase(":memory:");
  migrate(db);
  insertQueuedItem(db, { id: "item-1", sessionKey: "ses_1", now: 1_000 });
  const { item, run } = beginImplementRun(db, "item-1", 1_000);
  const lines: string[] = [];
  const restore = setJournalSink((line) => lines.push(line));
  deferWorkItem(db, item, {
    retry: 2,
    delayMs: 5_000,
    handoff: "keep going",
    message: "Linear GraphQL: RATELIMITED. Paws tries again in 5 s.",
    now: 2_000,
  });
  restore();
  expect(lines).toContain("item item-1 deferred: retry 2 in 5000 ms");
  expect(getWorkItem(db, "item-1")?.state).toBe("recovering");
  expect(getRun(db, run.id)?.status).toBe("lost");
  expect(listJobs(db).filter((job) => job.queue === JOB_KIND.resume)).toMatchObject([
    {
      status: "pending",
      runAt: 7_000,
      payload: {
        itemId: "item-1",
        runId: run.id,
        reason: "transient_failure",
        retry: 2,
        handoff: "keep going",
      },
    },
  ]);
  expect(listOutbox(db).map((row) => row.payload)).toContainEqual(
    expect.objectContaining({
      sessionId: "ses_1",
      kind: "thought",
      body: "Linear GraphQL: RATELIMITED. Paws tries again in 5 s.",
    }),
  );
});

test("deferring the same item version twice schedules one resume", () => {
  const db = openDatabase(":memory:");
  migrate(db);
  insertQueuedItem(db, { id: "item-1", now: 1_000 });
  const { item } = beginImplementRun(db, "item-1", 1_000);
  const input = { retry: 1, delayMs: 10, handoff: null, message: "Retrying.", now: 2_000 };
  deferWorkItem(db, item, input);
  deferWorkItem(db, getWorkItem(db, "item-1")!, { ...input, retry: 2 });
  expect(listJobs(db).filter((job) => job.queue === JOB_KIND.resume)).toHaveLength(1);
  expect(getWorkItem(db, "item-1")?.state).toBe("recovering");
});
