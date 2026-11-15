import { FakeClock, JOB_KIND } from "../../src/core";
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
  saveCheckpoint,
  setCurrentRun,
} from "../../src/db";
import { findOpenQuestion } from "../../src/questions";
import { answerPg } from "../questions";
import { tempStore } from "../pglite";
import { recoverStalledCloseout } from "../../src/loop/closeout-stall";
import { questionEffects } from "../../src/loop/question-effects";
import type { Proof } from "./harness";

export default {
  covers: [
    "src/loop/closeout-stall.ts",
    "src/loop/orchestrator.ts",
    "test/closeout-rules-first.test.ts",
  ],
  summary:
    "Idle remote checks retry at fifteen minutes, then ask a person; a twenty-minute command continues.",
  agent: () => [],
  async run(proof) {
    const child = Bun.spawn(
      ["bun", "test", "test/closeout-rules-first.test.ts", "--test-name-pattern", "idle checks"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    proof.expect(
      "runner waits consume no retry and unfinished commands do not protect later attempts",
      status === 0,
      { stdout, stderr },
    );
    const { db, close } = await tempStore();
    try {
      const clock = new FakeClock(Date.now() + 1000);
      await insertQueuedItem(db, { id: "quiet", sessionKey: "quiet-session", now: clock.now() });
      await beginImplementRun(db, "quiet", clock.now());
      await applyWorkItemEvent(db, "quiet", "turn_ended", { now: clock.now() });
      await saveCheckpoint(db, "quiet", {
        phase: "verifying",
        baseSha: "base",
        wipCommit: "head",
      });
      const oldJob = await enqueueJob(db, {
        queue: JOB_KIND.reverify,
        payload: { itemId: "quiet" },
        now: clock.now(),
      });
      await claimNextJob(db, { now: clock.now(), leaseMs: 60 * 60_000 });
      const lines: string[] = [];
      let since = clock.now();
      let running = true;
      const recover = () =>
        recoverStalledCloseout(db, {
          now: clock.now(),
          checksActivity: () => ({ since, running }),
          cancel: async () => {},
          journal: (line) => lines.push(line),
        });
      clock.advance(20 * 60_000);
      await recover();
      proof.expect("a twenty-minute command continues", lines.length === 0);
      running = false;
      since = clock.now();
      for (let attempt = 0; attempt < 2; attempt++) {
        clock.advance(15 * 60_000);
        await recover();
        since = clock.now();
        if (attempt === 0) {
          await markRun(db, (await getWorkItem(db, "quiet"))!.currentRunId!, "lost", clock.now());
          const rerun = await insertRun(db, {
            itemId: "quiet",
            kind: "recheck",
            agent: "cursor",
            status: "active",
            freshSession: true,
            now: clock.now(),
          });
          await setCurrentRun(db, "quiet", rerun.id);
        }
      }
      proof.expect(
        "only one automatic retry was queued",
        (await listJobs(db)).filter((j) => j.queue === JOB_KIND.reverify && j.id !== oldJob)
          .length === 1,
      );
      proof.expect(
        "the leased quiet job was cancelled",
        (await listJobs(db)).find((job) => job.id === oldJob)?.status === "cancelled",
      );
      proof.expect("one retry journal line", lines.length === 1, lines);
      proof.expect(
        "second stall asks a person",
        (await getWorkItem(db, "quiet"))?.state === "awaiting_input",
        await findOpenQuestion(db, "quiet-session"),
      );
      await answerPg(
        db,
        {
          sessionId: "quiet-session",
          deliveryId: "retry-answer",
          body: "Retry Closeout",
          answeredBy: "pascal",
          now: clock.now(),
        },
        questionEffects(db, { now: clock.now() }),
      );
      proof.expect(
        "person retries verification on the same head",
        (await getWorkItem(db, "quiet"))?.state === "verifying" &&
          (await getWorkItem(db, "quiet"))?.checkpoint?.wipCommit === "head",
      );
    } finally {
      await close();
    }
  },
} satisfies Proof;
