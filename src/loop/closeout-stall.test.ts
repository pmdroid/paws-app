import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, JOB_KIND } from "../core";
import {
  applyWorkItemEvent,
  beginImplementRun,
  claimNextJob,
  markRun,
  enqueueJob,
  getWorkItem,
  insertQueuedItem,
  insertRun,
  listJobs,
  migrate,
  openDatabase,
  recordAgentCloseout,
  saveCheckpoint,
  setCurrentRun,
  startUsagePause,
  sqliteDb,
} from "../db";
import { answerSteps, findOpenQuestion } from "../questions";
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
    await beginImplementRun(sqliteDb(db), "stalled", clock.now());
    await applyWorkItemEvent(sqliteDb(db), "stalled", "turn_ended", { now: clock.now() });
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
    await recordAgentCloseout(
      sqliteDb(db),
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
    expect(cancelled).toHaveLength(0);
    expect(await listJobs(sqliteDb(db))).toHaveLength(0);
    // Restart with no in-memory Closeout operation and retain the last event's clock.
    db.close();
    db = openDatabase(path);
    const oldJob = await enqueueJob(sqliteDb(db), {
      queue: JOB_KIND.reverify,
      payload: { itemId: "stalled" },
      now: clock.now(),
    });
    await claimNextJob(sqliteDb(db), { now: clock.now(), leaseMs: 60 * 60_000 });
    clock.advance(31 * 60_000);
    await check();
    expect((await listJobs(sqliteDb(db))).find((job) => job.id === oldJob)?.status).toBe(
      "cancelled",
    );
    await check();
    expect(
      (await listJobs(sqliteDb(db))).filter(
        (j) => j.queue === JOB_KIND.reverify && j.id !== oldJob,
      ),
    ).toHaveLength(1);
    expect(lines).toEqual(["closeout stalled for 31 min, re-running once"]);
    // The real re-verify closes the quiet run and opens a new one on the same head.
    const prior = getWorkItem(db, "stalled")!.currentRunId!;
    await markRun(sqliteDb(db), prior, "lost", clock.now());
    const rerun = await insertRun(sqliteDb(db), {
      itemId: "stalled",
      kind: "recheck",
      agent: "cursor",
      status: "active",
      freshSession: true,
      now: clock.now(),
    });
    await setCurrentRun(sqliteDb(db), "stalled", rerun.id);
    db.close();
    db = openDatabase(path);
    clock.advance(31 * 60_000);
    await check();
    await check();
    expect((await findOpenQuestion(sqliteDb(db), "ses"))?.options).toEqual([
      "Retry Closeout",
      "Send back to the agent",
    ]);
    expect(cancelled).toHaveLength(2);
    expect(
      (await listJobs(sqliteDb(db))).filter(
        (j) => j.queue === JOB_KIND.reverify && j.id !== oldJob,
      ),
    ).toHaveLength(1);
    await sqliteDb(db).transaction((q) =>
      answerSteps(
        q,
        {
          sessionId: "ses",
          deliveryId: "retry",
          body: "Retry Closeout",
          answeredBy: "person",
          now: clock.now(),
        },
        questionEffects(db, { now: clock.now() }),
      ),
    );
    expect(getWorkItem(db, "stalled")?.state).toBe("verifying");
    expect(getWorkItem(db, "stalled")?.checkpoint?.wipCommit).toBe("head");
  } finally {
    db.close();
    rmSync(root, { recursive: true });
  }
});

async function verifyingItem(id: string, db: ReturnType<typeof openDatabase>, now: number) {
  insertQueuedItem(db, { id, sessionKey: `ses-${id}`, now });
  await beginImplementRun(sqliteDb(db), id, now);
  await applyWorkItemEvent(sqliteDb(db), id, "turn_ended", { now });
  saveCheckpoint(db, id, { phase: "verifying", baseSha: "base", wipCommit: "head" });
}

test("a usage pause is not a stall, and one failed cancel leaves the other items recovered", async () => {
  const db = openDatabase(":memory:");
  try {
    migrate(db);
    const clock = new FakeClock(Date.now() + 1000);
    for (const id of ["paused", "broken", "quiet"]) await verifyingItem(id, db, clock.now());
    await startUsagePause(sqliteDb(db), {
      runId: getWorkItem(db, "paused")!.currentRunId!,
      itemId: "paused",
      agent: "cursor",
      runnerId: null,
      pausedAt: clock.now(),
      resetsAt: null,
      resumeAt: clock.now() + 120 * 60_000,
    });
    clock.advance(31 * 60_000);
    const lines: string[] = [];
    await recoverStalledCloseout(db, {
      now: clock.now(),
      cancel: async (id) => {
        if (id === "broken") throw new Error("runner did not confirm");
      },
      journal: (line) => lines.push(line),
    });
    const retried = (await listJobs(sqliteDb(db))).map(
      (job) => (job.payload as { itemId: string }).itemId,
    );
    expect(retried).toEqual(["quiet"]);
  } finally {
    db.close();
  }
});
