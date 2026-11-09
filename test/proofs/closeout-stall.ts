import { FakeClock, JOB_KIND } from "../../src/core";
import {
  applyWorkItemEvent,
  beginImplementRun,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  migrate,
  openDatabase,
  saveCheckpoint,
} from "../../src/db";
import { answer, findOpenQuestion } from "../../src/questions";
import { recoverStalledCloseout } from "../../src/loop/closeout-stall";
import { questionEffects } from "../../src/loop/question-effects";
import type { Proof } from "./harness";

export default {
  covers: ["src/loop/closeout-stall.ts"],
  summary:
    "Quiet verification retries once, then asks a person whose Retry Closeout answer verifies the same head.",
  agent: () => [],
  async run(proof) {
    const db = openDatabase(":memory:");
    try {
      migrate(db);
      const clock = new FakeClock(Date.now() + 1000);
      insertQueuedItem(db, { id: "quiet", sessionKey: "quiet-session", now: clock.now() });
      beginImplementRun(db, "quiet", clock.now());
      applyWorkItemEvent(db, "quiet", "turn_ended", { now: clock.now() });
      saveCheckpoint(db, "quiet", { phase: "verifying", baseSha: "base", wipCommit: "head" });
      const lines: string[] = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        clock.advance(31 * 60_000);
        await recoverStalledCloseout(db, {
          now: clock.now(),
          cancel: async () => {},
          journal: (line) => lines.push(line),
        });
      }
      proof.expect(
        "only one automatic retry was queued",
        listJobs(db).filter((j) => j.queue === JOB_KIND.reverify).length === 1,
      );
      proof.expect("one retry journal line", lines.length === 1, lines);
      proof.expect(
        "second stall asks a person",
        getWorkItem(db, "quiet")?.state === "awaiting_input",
        findOpenQuestion(db, "quiet-session"),
      );
      answer(
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
        getWorkItem(db, "quiet")?.state === "verifying" &&
          getWorkItem(db, "quiet")?.checkpoint?.wipCommit === "head",
      );
    } finally {
      db.close();
    }
  },
} satisfies Proof;
