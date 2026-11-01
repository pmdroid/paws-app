import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JOB_KIND } from "../core";
import {
  applyWorkItemEvent,
  beginImplementRun,
  cancelOpenJobs,
  enqueueJob,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  listOutbox,
  listPendingLinearTurns,
  recordLinearTurn,
  insertRun,
  setCurrentRun,
  migrate,
  openDatabase,
  recoverOnStartup,
  requeueOrphanedWork,
  restart,
} from "../db";
import { answer, findOpenQuestion, ask as rawAsk, getQuestion } from "../questions";
import { ask } from "./operations";
import { reaskDeadQuestion } from "./dead-question";
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

test("a dead restart elicitation preserves the decision question and resumes once on answer", () => {
  const db = openDatabase(":memory:");
  try {
    migrate(db);
    const item = insertQueuedItem(db, { sessionKey: "ses", now: NOW });
    beginImplementRun(db, item.id, NOW);
    recoverOnStartup(db, NOW);
    recoverOnStartup(db, NOW);
    const current = getWorkItem(db, item.id)!;
    const { question } = ask(
      db,
      { itemId: item.id, runId: current.currentRunId, sessionId: "ses", version: current.version },
      "agent",
      "Start again?",
      { reason: "restart", options: ["Start again"], now: NOW },
    );
    db.run("UPDATE outbox SET status='dead',error='Linear is down' WHERE op='elicitation'");
    const jobId = enqueueJob(db, {
      queue: JOB_KIND.reaskQuestion,
      payload: { itemId: item.id, questionId: question.id },
      now: NOW,
    });
    expect(
      reaskDeadQuestion(db, { itemId: item.id, questionId: question.id, jobId, now: LATER }),
    ).toBe(question.id);
    expect(findOpenQuestion(db, "ses")?.id).toBe(question.id);
    expect(
      db.query("SELECT question_id FROM restart_decision WHERE item_id=?").get(item.id),
    ).toEqual({ question_id: question.id });
    const deliveries = listOutbox(db, "ses").filter((row) => row.op === "elicitation");
    expect(deliveries.map((row) => row.status)).toEqual(["dropped", "pending"]);
    expect(deliveries[1]?.payload).toEqual(deliveries[0]?.payload);
    expect(requeueOrphanedWork(db, LATER)).toEqual([]);
    recoverOnStartup(db, LATER);
    expect(
      listJobs(db).filter((job) => job.queue === "run.resume" && job.status === "pending"),
    ).toHaveLength(0);
    const reply = {
      sessionId: "ses",
      deliveryId: "reply",
      body: "Start again",
      answeredBy: "pascal",
      now: LATER,
    };
    const effects = questionEffects(db, { now: LATER });
    expect(answer(db, reply, effects).status).toBe("answered");
    expect(answer(db, reply, effects).status).toBe("duplicate");
    expect(
      listJobs(db).filter((job) => job.queue === "run.resume" && job.status === "pending"),
    ).toHaveLength(1);
    expect(db.query("SELECT * FROM restart_decision WHERE item_id=?").get(item.id)).toBeNull();
    expect(getWorkItem(db, item.id)?.recoveryAttempts).toBe(1);
  } finally {
    db.close();
  }
});

function heldFixture() {
  const db = openDatabase(":memory:");
  migrate(db);
  const item = insertQueuedItem(db, { sessionKey: "ses", now: NOW });
  beginImplementRun(db, item.id, NOW);
  recoverOnStartup(db, NOW);
  recoverOnStartup(db, NOW);
  const current = getWorkItem(db, item.id)!;
  const owner = { itemId: item.id, runId: current.currentRunId, sessionId: "ses" };
  return { db, item, owner };
}

function replyToRestart(
  db: ReturnType<typeof openDatabase>,
  deliveryId: string,
  body = "Start again",
) {
  return answer(
    db,
    { sessionId: "ses", deliveryId, body, answeredBy: "pascal", now: LATER },
    questionEffects(db, { now: LATER }),
  );
}

test("a legacy restart question with no run accepts its answer", () => {
  const { db, item, owner } = heldFixture();
  try {
    ask(db, { ...owner, runId: null }, "agent", "Restart?", { reason: "restart", now: NOW });
    expect(replyToRestart(db, "null-run").status).toBe("answered");
    expect(getWorkItem(db, item.id)?.state).toBe("queued");
    expect(
      listJobs(db).filter((job) => job.queue === "run.resume" && job.status === "pending"),
    ).toHaveLength(1);
  } finally {
    db.close();
  }
});

test("a stale-run restart answer consumes the turn and explains why it cannot resume", () => {
  const { db, item, owner } = heldFixture();
  try {
    ask(db, owner, "agent", "Restart?", { reason: "restart", now: NOW });
    const other = insertRun(db, { itemId: item.id, now: NOW, status: "active" });
    setCurrentRun(db, item.id, other.id);
    recordLinearTurn(db, {
      sessionId: "ses",
      eventKey: "stale-run",
      activityId: "stale-run",
      actorId: "pascal",
      body: "Start again",
      payload: "{}",
      createdAtMs: LATER,
    });
    expect(replyToRestart(db, "stale-run").status).toBe("answered");
    expect(listPendingLinearTurns(db, "ses")).toEqual([]);
    expect(getWorkItem(db, item.id)?.state).toBe("awaiting_input");
    expect(
      listOutbox(db).some((row) =>
        (row.payload as { body?: string }).body?.includes("ownership or controls changed"),
      ),
    ).toBe(true);
  } finally {
    db.close();
  }
});

test("an answered restart decision survives repair while another question waits", () => {
  const { db, item, owner } = heldFixture();
  try {
    const first = ask(db, owner, "agent", "Restart?", { reason: "restart", now: NOW });
    const other = ask(db, owner, "agent", "Which implementation?", { now: NOW + 1 });
    expect(replyToRestart(db, "restart-first").status).toBe("answered");
    expect(findOpenQuestion(db, "ses")?.id).toBe(other.question.id);
    db.run("UPDATE job SET status='done',finished_at=? WHERE queue='item.ask'", [NOW]);
    for (let i = 0; i < 3; i++) {
      requeueOrphanedWork(db, LATER + i);
      recoverOnStartup(db, LATER + i);
    }
    const redelivery = listJobs(db).find(
      (job) => job.queue === "item.ask" && job.status === "pending",
    );
    if (redelivery) ask(db, owner, "agent", "Restart?", { reason: "restart", now: LATER });
    expect(
      db.query("SELECT question_id FROM restart_decision WHERE item_id=?").get(item.id),
    ).toEqual({ question_id: first.question.id });
    expect(db.query("SELECT id FROM question").all()).toHaveLength(2);
    expect(replyToRestart(db, "other-answer", "Use the smaller implementation").status).toBe(
      "answered",
    );
    const resumes = listJobs(db).filter(
      (job) => job.queue === "run.resume" && job.status === "pending",
    );
    expect(resumes).toHaveLength(1);
    expect((resumes[0]!.payload as { handoff: string }).handoff).toContain("Start again");
    expect((resumes[0]!.payload as { handoff: string }).handoff).toContain(
      "Use the smaller implementation",
    );
  } finally {
    db.close();
  }
});

test("adoption chooses the newest compatible question and retires duplicate and stale copies", () => {
  const { db, owner } = heldFixture();
  try {
    const old = rawAsk(db, owner, "agent", "Old restart?", { reason: "restart", now: NOW });
    const newest = rawAsk(db, owner, "agent", "New restart?", { reason: "restart", now: NOW + 1 });
    const stale = rawAsk(db, { ...owner, runId: null }, "agent", "Stale restart?", {
      reason: "restart",
      now: NOW + 2,
    });
    const otherRun = insertRun(db, { itemId: owner.itemId, now: NOW, status: "lost" });
    db.run("UPDATE question SET status='queued' WHERE id=?", [old.question.id]);
    db.run("UPDATE question SET status='open' WHERE id=?", [newest.question.id]);
    db.run("UPDATE question SET run_id=? WHERE id=?", [otherRun.id, stale.question.id]);
    const adopted = ask(db, owner, "agent", "Restart?", { reason: "restart", now: LATER });
    expect(adopted.question.id).toBe(newest.question.id);
    expect(getQuestion(db, old.question.id)?.cancelledAt).toBe(LATER);
    expect(getQuestion(db, stale.question.id)?.cancelledAt).toBe(LATER);
    expect(findOpenQuestion(db, "ses")?.id).toBe(newest.question.id);
    expect(replyToRestart(db, "duplicate-owner").status).toBe("answered");
    expect(getWorkItem(db, owner.itemId)?.state).toBe("queued");
  } finally {
    db.close();
  }
});

for (const exhausted of ["dead", "completed-without-question"] as const) {
  test(`orphan repair bounds ${exhausted} delivery and preserves other pending work`, () => {
    const { db, item } = heldFixture();
    try {
      const request = listJobs(db).find((job) => job.queue === "item.ask")!;
      const unrelated = enqueueJob(db, {
        queue: "item.notice",
        payload: { itemId: item.id },
        now: NOW,
      });
      if (exhausted === "dead")
        db.run("UPDATE job SET status='dead',attempts=max_attempts WHERE id=?", [request.id]);
      for (let i = 0; i < request.maxAttempts + 2; i++) {
        if (
          exhausted !== "dead" &&
          listJobs(db).find((job) => job.id === request.id)?.status !== "dead"
        )
          db.run("UPDATE job SET status='done',finished_at=? WHERE id=?", [NOW, request.id]);
        requeueOrphanedWork(db, LATER + i * 60_000);
      }
      expect(listJobs(db).find((job) => job.id === request.id)?.status).toBe("dead");
      expect(listJobs(db).find((job) => job.id === unrelated)?.status).toBe("pending");
      expect(getWorkItem(db, item.id)?.state).toBe("recovering");
      expect(
        listJobs(db).filter((job) => job.queue === "run.resume" && job.status === "pending"),
      ).toHaveLength(0);
    } finally {
      db.close();
    }
  });
}

test("cancel clears delivery metadata through the work-item lifecycle", () => {
  const { db, item } = heldFixture();
  try {
    applyWorkItemEvent(db, item.id, "cancel");
    expect(db.query("SELECT * FROM restart_decision").all()).toEqual([]);
    expect(requeueOrphanedWork(db, LATER)).toEqual([]);
    recoverOnStartup(db, LATER);
    expect(getWorkItem(db, item.id)?.state).toBe("cancelled");
  } finally {
    db.close();
  }
});
