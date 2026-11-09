import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, JOB_KIND } from "../core";
import {
  applyWorkItemEvent,
  beginImplementRun,
  claimNextJob,
  enqueueJob,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  migrate,
  openDatabase,
  recordAgentCloseout,
  saveCheckpoint,
} from "../db";
import { answer, findOpenQuestion } from "../questions";
import { questionEffects } from "./question-effects";
import { recoverStalledCloseout } from "./closeout-stall";

test("quiet verification retries once across restart, then asks a person", async () => {
  const root = mkdtempSync(join(tmpdir(), "closeout-stall-"));
  const path = join(root, "paws.db");
  let db = openDatabase(path);
  try {
    migrate(db);
    const clock = new FakeClock(Date.now() + 1000);
    insertQueuedItem(db, { id: "stalled", sessionKey: "ses", now: clock.now() });
    beginImplementRun(db, "stalled", clock.now());
    applyWorkItemEvent(db, "stalled", "turn_ended", { now: clock.now() });
    saveCheckpoint(db, "stalled", { phase: "verifying", baseSha: "base", wipCommit: "head" });
    const lines: string[] = [];
    const cancelled: string[] = [];
    const check = () =>
      recoverStalledCloseout(db, {
        now: clock.now(),
        cancel: async (id) => {
          cancelled.push(id);
        },
        journal: (line) => lines.push(line),
      });
    clock.advance(31 * 60_000);
    recordAgentCloseout(
      db,
      getWorkItem(db, "stalled")!.currentRunId!,
      "stalled",
      {
        type: "report",
        head: "head",
        maxAttempts: 3,
        checks: [],
        blocked: null,
      },
      clock.now(),
    );
    await check();
    expect(lines).toHaveLength(0);
    // Restart with no in-memory Closeout operation and retain the last event's clock.
    db.close();
    db = openDatabase(path);
    const oldJob = enqueueJob(db, {
      queue: JOB_KIND.reverify,
      payload: { itemId: "stalled" },
      now: clock.now(),
    });
    claimNextJob(db, { now: clock.now(), leaseMs: 60 * 60_000 });
    clock.advance(31 * 60_000);
    await check();
    expect(listJobs(db).find((job) => job.id === oldJob)?.status).toBe("cancelled");
    await check();
    expect(
      listJobs(db).filter((j) => j.queue === JOB_KIND.reverify && j.id !== oldJob),
    ).toHaveLength(1);
    expect(lines).toEqual(["closeout stalled for 31 min, re-running once"]);
    db.close();
    db = openDatabase(path);
    clock.advance(31 * 60_000);
    await check();
    await check();
    expect(findOpenQuestion(db, "ses")?.options).toEqual([
      "Retry Closeout",
      "Send back to the agent",
    ]);
    expect(cancelled).toHaveLength(2);
    expect(
      listJobs(db).filter((j) => j.queue === JOB_KIND.reverify && j.id !== oldJob),
    ).toHaveLength(1);
    answer(
      db,
      {
        sessionId: "ses",
        deliveryId: "retry",
        body: "Retry Closeout",
        answeredBy: "person",
        now: clock.now(),
      },
      questionEffects(db, { now: clock.now() }),
    );
    expect(getWorkItem(db, "stalled")?.state).toBe("verifying");
    expect(getWorkItem(db, "stalled")?.checkpoint?.wipCommit).toBe("head");
  } finally {
    db.close();
    rmSync(root, { recursive: true });
  }
});
