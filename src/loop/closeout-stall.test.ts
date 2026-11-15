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
  recordAgentCloseout,
  saveCheckpoint,
  setCurrentRun,
  startUsagePause,
  openPawsStore,
  type Db,
  type PawsStore,
} from "../db";
import { answerSteps, findOpenQuestion } from "../questions";
import { questionEffects } from "./question-effects";
import { recoverStalledCloseout } from "./closeout-stall";
import { copyMigratedPglite, tempStore } from "../../test/pglite";

test("quiet verification retries once across restart, then asks a person", async () => {
  const root = mkdtempSync(join(tmpdir(), "closeout-stall-"));
  const pgliteDir = join(root, "pglite");
  await copyMigratedPglite(pgliteDir);
  let opened: PawsStore | undefined;
  const reopen = async () => {
    await opened?.close();
    opened = await openPawsStore({ url: null, pgliteDir });
    return opened.store;
  };
  let db = await reopen();
  try {
    const clock = new FakeClock(Date.now() + 1000);
    await insertQueuedItem(db, { id: "stalled", sessionKey: "ses", now: clock.now() });
    await beginImplementRun(db, "stalled", clock.now());
    await applyWorkItemEvent(db, "stalled", "turn_ended", { now: clock.now() });
    await saveCheckpoint(db, "stalled", {
      phase: "verifying",
      baseSha: "base",
      wipCommit: "head",
    });
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
      db,
      (await getWorkItem(db, "stalled"))!.currentRunId!,
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
    expect(await listJobs(db)).toHaveLength(0);
    // Restart with no in-memory Closeout operation and retain the last event's clock.
    db = await reopen();
    const oldJob = await enqueueJob(db, {
      queue: JOB_KIND.reverify,
      payload: { itemId: "stalled" },
      now: clock.now(),
    });
    await claimNextJob(db, { now: clock.now(), leaseMs: 60 * 60_000 });
    clock.advance(31 * 60_000);
    await check();
    expect((await listJobs(db)).find((job) => job.id === oldJob)?.status).toBe("cancelled");
    await check();
    expect(
      (await listJobs(db)).filter((j) => j.queue === JOB_KIND.reverify && j.id !== oldJob),
    ).toHaveLength(1);
    expect(lines).toEqual(["closeout stalled for 31 min, re-running once"]);
    // The real re-verify closes the quiet run and opens a new one on the same head.
    const prior = (await getWorkItem(db, "stalled"))!.currentRunId!;
    await markRun(db, prior, "lost", clock.now());
    const rerun = await insertRun(db, {
      itemId: "stalled",
      kind: "recheck",
      agent: "cursor",
      status: "active",
      freshSession: true,
      now: clock.now(),
    });
    await setCurrentRun(db, "stalled", rerun.id);
    db = await reopen();
    clock.advance(31 * 60_000);
    await check();
    await check();
    expect((await findOpenQuestion(db, "ses"))?.options).toEqual([
      "Retry Closeout",
      "Send back to the agent",
    ]);
    expect(cancelled).toHaveLength(2);
    expect(
      (await listJobs(db)).filter((j) => j.queue === JOB_KIND.reverify && j.id !== oldJob),
    ).toHaveLength(1);
    await db.transaction((q) =>
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
    expect((await getWorkItem(db, "stalled"))?.state).toBe("verifying");
    expect((await getWorkItem(db, "stalled"))?.checkpoint?.wipCommit).toBe("head");
  } finally {
    await opened?.close();
    rmSync(root, { recursive: true });
  }
});

async function verifyingItem(id: string, db: Db, now: number) {
  await insertQueuedItem(db, { id, sessionKey: `ses-${id}`, now });
  await beginImplementRun(db, id, now);
  await applyWorkItemEvent(db, id, "turn_ended", { now });
  await saveCheckpoint(db, id, {
    phase: "verifying",
    baseSha: "base",
    wipCommit: "head",
  });
}

test("a usage pause is not a stall, and one failed cancel leaves the other items recovered", async () => {
  const { db, close } = await tempStore();
  try {
    const clock = new FakeClock(Date.now() + 1000);
    for (const id of ["paused", "broken", "quiet"]) await verifyingItem(id, db, clock.now());
    await startUsagePause(db, {
      runId: (await getWorkItem(db, "paused"))!.currentRunId!,
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
    const retried = (await listJobs(db)).map((job) => (job.payload as { itemId: string }).itemId);
    expect(retried).toEqual(["quiet"]);
  } finally {
    await close();
  }
});
