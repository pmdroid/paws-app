import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyWorkItemEvent,
  beginImplementRun,
  cancelOpenJobs,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  migrate,
  openDatabase,
  recoverOnStartup,
  requeueOrphanedWork,
  restart,
} from "../db";
import { answer, findOpenQuestion } from "../questions";
import { ask } from "./operations";
import { questionEffects } from "./question-effects";

const NOW = 20_000;
const LATER = NOW + 45 * 60_000;

for (const delivery of ["pending", "cancelled", "done", "missing"] as const) {
  test(`restart hold survives reopen and repeated startup with ${delivery} delivery`, () => {
    const dir = mkdtempSync(join(tmpdir(), "paws-restart-"));
    const path = join(dir, "paws.db");
    let db = openDatabase(path);
    try {
      migrate(db);
      const item = insertQueuedItem(db, { sessionKey: "ses", now: NOW });
      beginImplementRun(db, item.id, NOW);
      recoverOnStartup(db, NOW);
      recoverOnStartup(db, NOW);
      const request = listJobs(db).find((job) => job.queue === "item.ask")!;
      if (delivery === "missing") db.run("DELETE FROM job WHERE id=?", [request.id]);
      else if (delivery !== "pending")
        db.run("UPDATE job SET status=?,finished_at=? WHERE id=?", [delivery, NOW, request.id]);
      db.close();
      db = openDatabase(path);
      for (let i = 0; i < 3; i++) {
        // Orphan repair must restore the question even without a startup pass.
        expect(requeueOrphanedWork(db, LATER + i)).toEqual([]);
        recoverOnStartup(db, LATER + i);
        const jobs = listJobs(db).filter((job) => ["pending", "running"].includes(job.status));
        expect(jobs).toHaveLength(1);
        expect(jobs[0]?.queue).toBe("item.ask");
        expect(getWorkItem(db, item.id)).toMatchObject({
          state: "recovering",
          recoveryAttempts: 1,
        });
        db.close();
        db = openDatabase(path);
      }
      const owner = {
        itemId: item.id,
        runId: getWorkItem(db, item.id)!.currentRunId,
        sessionId: "ses",
      };
      const first = ask(db, owner, "agent", "Start again?", { reason: "restart", now: LATER });
      expect(
        ask(db, owner, "agent", "Start again?", { reason: "restart", now: LATER }).question.id,
      ).toBe(first.question.id);
      db.run("UPDATE job SET status='done',finished_at=? WHERE queue='item.ask'", [NOW]);
      expect(requeueOrphanedWork(db, LATER)).toEqual([]);
      recoverOnStartup(db, LATER);
      expect(findOpenQuestion(db, "ses")?.id).toBe(first.question.id);
      expect(
        restart(db, getWorkItem(db, item.id)!, { reason: "ci", body: "retry", now: LATER }),
      ).toBeNull();
      const reply = {
        sessionId: "ses",
        deliveryId: "reply",
        body: "Start again",
        answeredBy: "pascal",
        now: LATER,
      };
      const effects = questionEffects(db, { now: LATER });
      const result = answer(db, reply, effects);
      expect(result.status).toBe("answered");
      expect(answer(db, reply, effects).status).toBe("duplicate");
      expect(answer(db, { ...reply, deliveryId: "stale" }, effects).status).toBe("unasked");
      if (result.status === "answered") effects.agent?.(result.question);
      recoverOnStartup(db, LATER);
      const resumes = listJobs(db).filter(
        (job) => job.queue === "run.resume" && job.status === "pending",
      );
      expect(resumes).toHaveLength(1);
      expect(resumes[0]?.jobKey).toBe(`resume:answer:${first.question.id}`);
      expect(getWorkItem(db, item.id)?.recoveryAttempts).toBe(1);
      // Reuse the run and session for a later recovery cycle. Its old answer has no authority.
      db.run("UPDATE job SET status='done',finished_at=? WHERE job_key=?", [
        LATER,
        resumes[0]!.jobKey,
      ]);
      applyWorkItemEvent(db, item.id, "dispatched");
      recoverOnStartup(db, LATER + 1);
      recoverOnStartup(db, LATER + 1);
      const next = ask(db, owner, "agent", "Start again?", { reason: "restart", now: LATER + 1 });
      expect(next.question.id).not.toBe(first.question.id);
      if (result.status === "answered") effects.agent?.(result.question);
      expect(getWorkItem(db, item.id)?.state).toBe("awaiting_input");
      expect(findOpenQuestion(db, "ses")?.id).toBe(next.question.id);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("restart intent, cancellation and enqueue commit together", () => {
  const db = openDatabase(":memory:");
  try {
    migrate(db);
    const item = insertQueuedItem(db, { sessionKey: "ses", now: NOW });
    beginImplementRun(db, item.id, NOW);
    recoverOnStartup(db, NOW);
    db.run(`CREATE TRIGGER crash_enqueue BEFORE INSERT ON job WHEN NEW.queue='item.ask'
      BEGIN SELECT RAISE(ABORT,'crash'); END`);
    expect(() => recoverOnStartup(db, NOW)).toThrow("crash");
    expect(db.query("SELECT * FROM restart_decision").all()).toHaveLength(0);
    expect(listJobs(db).filter((job) => job.status === "pending")).toHaveLength(1);
    db.run("DROP TRIGGER crash_enqueue");
    recoverOnStartup(db, NOW);
    cancelOpenJobs(db, { itemId: item.id, reason: "interruption", now: NOW });
    expect(requeueOrphanedWork(db, LATER)).toEqual([]);
    expect(
      listJobs(db)
        .filter((job) => job.status === "pending")
        .map((job) => job.queue),
    ).toEqual(["item.ask"]);
  } finally {
    db.close();
  }
});
