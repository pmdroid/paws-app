import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { FakeClock, JOB_KIND } from "../core";
import {
  DEFAULT_OUTBOX_MAX_ATTEMPTS,
  OutboxDispatcher,
  claimNextJob,
  enqueueJob,
  enqueueOutbox,
  failJob,
  getJob,
  insertQueuedItem,
  jobVersionCurrent,
  listDeadDeliveries,
  listJobs,
  listOutbox,
  migrate,
  openDatabase,
  retryDeadDelivery,
  setJournalSink,
} from "./index";

let lines: string[] = [];
let restore: () => void = () => {};
beforeEach(() => {
  lines = [];
  restore = setJournalSink((line) => lines.push(line));
});
afterEach(() => restore());

function harness() {
  const clock = new FakeClock(5_000);
  const db = openDatabase(":memory:");
  migrate(db);
  const dispatcher = new OutboxDispatcher(db, clock, { backoffBaseMs: 1_000 });
  return { clock, db, dispatcher };
}

function waiting(db: Database, id: string, session: string): void {
  insertQueuedItem(db, { id, sessionKey: session });
  db.run("UPDATE work_item SET state = 'awaiting_input' WHERE id = ?", [id]);
  db.run(
    `INSERT INTO question (id, item_id, session_id, body, status, created_at)
     VALUES (?, ?, ?, 'Which repository?', 'open', 0)`,
    [`q-${id}`, id, session],
  );
}

function elicit(db: Database, id: string, session: string): number {
  return enqueueOutbox(db, {
    target: "linear",
    op: "elicitation",
    orderingKey: session,
    idempotencyKey: `question:q-${id}`,
    payload: {
      id: `q-${id}`,
      sessionId: session,
      questionId: `q-${id}`,
      body: "Which repository?",
    },
    maxAttempts: 1,
  });
}

async function deliverAll(dispatcher: OutboxDispatcher, clock: FakeClock, rounds = 4) {
  for (let round = 0; round < rounds; round += 1) {
    dispatcher.tick();
    await dispatcher.idle();
    clock.advance(60_000);
  }
}

describe("dead outbox rows and jobs", () => {
  test("a dead row writes one journal line with the item, the kind and the last error", async () => {
    const { clock, db, dispatcher } = harness();
    insertQueuedItem(db, { id: "item-a", sessionKey: "ses-a" });
    enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      orderingKey: "ses-a",
      idempotencyKey: "a1",
      payload: { itemId: "item-a", kind: "thought", body: "Started." },
      maxAttempts: 2,
    });
    dispatcher.setHandler(() => {
      throw new Error("Linear\nsaid no");
    });
    await deliverAll(dispatcher, clock);
    expect(lines.filter((line) => line.startsWith("outbox "))).toEqual([
      "outbox 1 linear.activity dead item=item-a attempts=2/2 error=Linear said no",
    ]);
  });

  test("a dead job writes one journal line whatever its queue", () => {
    const { db } = harness();
    enqueueJob(db, {
      queue: JOB_KIND.catchup,
      payload: { itemId: "item-a" },
      maxAttempts: 1,
      now: 0,
    });
    const job = claimNextJob(db, { workerId: "w", now: 1_000, queues: [JOB_KIND.catchup] });
    failJob(db, job!, new Error("gone"), { now: 1_000 });
    expect(lines.filter((line) => line.startsWith("job "))).toEqual([
      `job 1 ${JOB_KIND.catchup} dead item=item-a attempts=1/1 error=gone`,
    ]);
  });

  test("a dead elicitation of a waiting item is re-enqueued once, then re-asked once per run", async () => {
    const { clock, db, dispatcher } = harness();
    waiting(db, "item-q", "ses-q");
    elicit(db, "item-q", "ses-q");
    const posted: string[] = [];
    dispatcher.setHandler((row) => {
      posted.push(row.idempotencyKey);
      throw new Error("Linear is down");
    });
    await deliverAll(dispatcher, clock, 10);

    const rows = listOutbox(db, "ses-q");
    expect(rows.map((row) => [row.idempotencyKey, row.status])).toEqual([
      ["question:q-item-q", "dropped"],
      ["question:q-item-q:redelivery", "dead"],
    ]);
    expect(rows[1]?.payload).toEqual(rows[0]?.payload as object);
    expect(posted).toEqual([
      "question:q-item-q",
      ...Array.from({ length: DEFAULT_OUTBOX_MAX_ATTEMPTS }, () => "question:q-item-q:redelivery"),
    ]);
    expect(lines.filter((line) => line.startsWith("outbox "))).toEqual([
      "outbox 1 linear.elicitation dead item=item-q attempts=1/1 error=Linear is down",
      "outbox 1 elicitation re-enqueued as outbox 2 item=item-q",
      "outbox 2 linear.elicitation dead item=item-q attempts=5/5 error=Linear is down",
      "outbox 2 elicitation dead again item=item-q; re-asking question q-item-q",
    ]);
    expect(listDeadDeliveries(db, "item-q").map((dead) => [dead.kind, dead.id])).toEqual([
      ["outbox", 2],
    ]);
    const reask = listJobs(db).filter((job) => job.queue === JOB_KIND.reaskQuestion);
    expect(reask.map((job) => [job.jobKey, job.payload])).toEqual([
      [`${JOB_KIND.reaskQuestion}:item-q:-`, { itemId: "item-q", questionId: "q-item-q" }],
    ]);

    // A second question of the same run that dies twice is not re-asked again.
    // Answering drops the question's dead rows (answerQuestion does this in src/questions).
    db.run("UPDATE question SET status = 'answered' WHERE id = 'q-item-q'");
    db.run("UPDATE outbox SET status = 'dropped' WHERE id = 2");
    db.run(
      `INSERT INTO question (id, item_id, session_id, body, status, created_at)
       VALUES ('q2', 'item-q', 'ses-q', 'And the branch?', 'open', 0)`,
    );
    enqueueOutbox(db, {
      target: "linear",
      op: "elicitation",
      orderingKey: "ses-q",
      idempotencyKey: "question:q2",
      payload: { id: "q2", sessionId: "ses-q", questionId: "q2", body: "And the branch?" },
      maxAttempts: 1,
    });
    lines = [];
    await deliverAll(dispatcher, clock, 10);
    expect(lines.filter((line) => line.startsWith("outbox ")).at(-1)).toBe(
      "outbox 4 elicitation dead again item=item-q; retry it from the issue page",
    );
    expect(listJobs(db).filter((job) => job.queue === JOB_KIND.reaskQuestion)).toHaveLength(1);
  });

  test("the re-enqueued elicitation is delivered when Linear recovers", async () => {
    const { clock, db, dispatcher } = harness();
    waiting(db, "item-q", "ses-q");
    elicit(db, "item-q", "ses-q");
    let fail = true;
    dispatcher.setHandler(() => {
      if (fail) {
        fail = false;
        throw new Error("timeout");
      }
    });
    await deliverAll(dispatcher, clock);
    expect(listOutbox(db, "ses-q").map((row) => row.status)).toEqual(["dropped", "sent"]);
  });

  test("an elicitation for an item that no longer waits stays dead", async () => {
    const { clock, db, dispatcher } = harness();
    waiting(db, "item-q", "ses-q");
    db.run("UPDATE work_item SET state = 'running' WHERE id = 'item-q'");
    elicit(db, "item-q", "ses-q");
    dispatcher.setHandler(() => {
      throw new Error("timeout");
    });
    await deliverAll(dispatcher, clock);
    expect(listOutbox(db, "ses-q").map((row) => row.status)).toEqual(["dead"]);
  });

  test("an answered question's elicitation is not re-enqueued", async () => {
    const { clock, db, dispatcher } = harness();
    waiting(db, "item-q", "ses-q");
    db.run("UPDATE question SET status = 'answered' WHERE id = 'q-item-q'");
    elicit(db, "item-q", "ses-q");
    dispatcher.setHandler(() => {
      throw new Error("timeout");
    });
    await deliverAll(dispatcher, clock);
    expect(listOutbox(db, "ses-q").map((row) => row.status)).toEqual(["dead"]);
  });

  test("retry puts a dead row or job of the item back to pending", async () => {
    const { clock, db, dispatcher } = harness();
    waiting(db, "item-q", "ses-q");
    db.run("UPDATE work_item SET state = 'running' WHERE id = 'item-q'");
    elicit(db, "item-q", "ses-q");
    dispatcher.setHandler(() => {
      throw new Error("timeout");
    });
    await deliverAll(dispatcher, clock);
    enqueueJob(db, { queue: JOB_KIND.resume, payload: { itemId: "item-q" }, maxAttempts: 1 });
    const job = claimNextJob(db, { workerId: "w", queues: [JOB_KIND.resume] });
    failJob(db, job!, new Error("runner lost"));
    expect(listDeadDeliveries(db, "item-q").map((dead) => [dead.kind, dead.name])).toEqual([
      ["outbox", "linear.elicitation"],
      ["job", JOB_KIND.resume],
    ]);

    expect(retryDeadDelivery(db, "other", { kind: "job", id: job!.id })).toBe(false);
    // The item moved on since the job was enqueued; the retried job must still count as current.
    db.run("UPDATE work_item SET version = version + 1 WHERE id = 'item-q'");
    expect(jobVersionCurrent(db, job!)).toBe(false);
    expect(retryDeadDelivery(db, "item-q", { kind: "job", id: job!.id })).toBe(true);
    expect(getJob(db, job!.id)?.status).toBe("pending");
    expect(jobVersionCurrent(db, job!)).toBe(true);
    expect(retryDeadDelivery(db, "item-q", { kind: "outbox", id: 1 }, clock.now())).toBe(true);
    expect(listDeadDeliveries(db, "item-q")).toEqual([]);

    dispatcher.setHandler(() => {});
    await deliverAll(dispatcher, clock, 1);
    expect(listOutbox(db, "ses-q").map((row) => row.status)).toEqual(["sent"]);
    expect(lines).toContain("outbox 1 retried item=item-q");
  });
});
