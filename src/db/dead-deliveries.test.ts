import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { FakeClock, JOB_KIND } from "../core";
import {
  DEFAULT_OUTBOX_MAX_ATTEMPTS,
  ELICITATION_REASK_SUFFIX,
  OutboxDispatcher,
  QUESTION_LINKS,
  deadDeliveryIsFinalStop,
  getOutbox,
  redeliverQuestion,
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
  recordQuestionReask,
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

  test("a dead elicitation of a waiting item is re-enqueued once, then re-asked", async () => {
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
      [`${JOB_KIND.reaskQuestion}:q-item-q`, { itemId: "item-q", questionId: "q-item-q" }],
    ]);
  });

  test("each question gets its own re-ask, and a re-asked question does not get another", async () => {
    const { clock, db, dispatcher } = harness();
    waiting(db, "item-q", "ses-q");
    dispatcher.setHandler(() => {
      throw new Error("Linear is down");
    });
    const question = (id: string) => {
      db.run(
        `INSERT INTO question (id, item_id, session_id, body, status, created_at)
         VALUES (?, 'item-q', 'ses-q', 'And the branch?', 'open', 0)`,
        [id],
      );
      enqueueOutbox(db, {
        target: "linear",
        op: "elicitation",
        orderingKey: "ses-q",
        idempotencyKey: `question:${id}`,
        payload: { id, sessionId: "ses-q", questionId: id, body: "And the branch?" },
        maxAttempts: 1,
      });
    };
    const reasks = () =>
      listJobs(db)
        .filter((job) => job.queue === JOB_KIND.reaskQuestion)
        .map((job) => job.jobKey);
    // A question that is answered drops its dead rows (answerQuestion does this in src/questions).
    const settle = (id: string) => {
      db.run("UPDATE question SET status = 'answered' WHERE id = ?", [id]);
      db.run("UPDATE outbox SET status = 'dropped' WHERE status = 'dead'");
    };

    elicit(db, "item-q", "ses-q");
    await deliverAll(dispatcher, clock, 10);
    settle("q-item-q");
    // A later, independent question in the same run still gets its own re-ask.
    question("q2");
    await deliverAll(dispatcher, clock, 10);
    expect(reasks()).toEqual([
      `${JOB_KIND.reaskQuestion}:q-item-q`,
      `${JOB_KIND.reaskQuestion}:q2`,
    ]);

    // The loop re-asked q2 as q3. When q3 dies twice too, it shares q2's allowance.
    const q2Job = listJobs(db).find((job) => job.jobKey === `${JOB_KIND.reaskQuestion}:q2`)!;
    recordQuestionReask(db, q2Job.id, "q3");
    settle("q2");
    question("q3");
    lines = [];
    await deliverAll(dispatcher, clock, 10);
    expect(reasks()).toHaveLength(2);
    expect(lines.filter((line) => line.startsWith("outbox ")).at(-1)).toMatch(
      /^outbox \d+ elicitation dead again item=item-q; retry it from the issue page$/,
    );

    // A question kept by id is delivered again under :reask; when that dies, it stays dead.
    settle("q3");
    db.run(
      `INSERT INTO question (id, item_id, session_id, body, status, created_at)
       VALUES ('q4', 'item-q', 'ses-q', 'Accept?', 'open', 0)`,
    );
    const reaskJob = enqueueJob(db, {
      queue: JOB_KIND.reaskQuestion,
      jobKey: `${JOB_KIND.reaskQuestion}:q4`,
      payload: { itemId: "item-q", questionId: "q4", reaskedAs: "q4" },
    });
    enqueueOutbox(db, {
      target: "linear",
      op: "elicitation",
      orderingKey: "ses-q",
      idempotencyKey: `question:q4${ELICITATION_REASK_SUFFIX}`,
      payload: { id: "q4", sessionId: "ses-q", questionId: "q4", body: "Accept?" },
      maxAttempts: 1,
    });
    await deliverAll(dispatcher, clock, 10);
    expect(
      listOutbox(db, "ses-q")
        .filter((row) => row.idempotencyKey.startsWith("question:q4"))
        .map((row) => [row.idempotencyKey, row.status]),
    ).toEqual([[`question:q4${ELICITATION_REASK_SUFFIX}`, "dead"]]);
    expect(reasks()).toHaveLength(3);
    expect(getJob(db, reaskJob)?.status).toBe("pending");
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
    expect(listDeadDeliveries(db, "item-q").map((dead) => dead.retryable)).toEqual([true, true]);
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

  test("a dead job from an earlier item version is listed but never retried", () => {
    const { db } = harness();
    waiting(db, "item-q", "ses-q");
    enqueueJob(db, { queue: JOB_KIND.resume, payload: { itemId: "item-q" }, maxAttempts: 1 });
    const job = claimNextJob(db, { workerId: "w", queues: [JOB_KIND.resume] });
    failJob(db, job!, new Error("runner lost"));
    // A restart, answer or stop moved the item on; the job's payload is now obsolete.
    db.run("UPDATE work_item SET version = version + 1 WHERE id = 'item-q'");

    expect(listDeadDeliveries(db, "item-q").map((dead) => [dead.kind, dead.retryable])).toEqual([
      ["job", false],
    ]);
    expect(retryDeadDelivery(db, "item-q", { kind: "job", id: job!.id })).toBe(false);
    expect(getJob(db, job!.id)?.status).toBe("dead");
    expect(jobVersionCurrent(db, job!)).toBe(false);
  });

  test("every question id column in the schema is a known question link", () => {
    const { db } = harness();
    const columns = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .flatMap(({ name }) =>
        db
          .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('${name}')`)
          .all()
          .filter((column) => column.name.endsWith("question_id"))
          .map((column) => `${name}.${column.name}`),
      )
      .sort();
    expect(columns).toEqual(QUESTION_LINKS.map(({ table, column }) => `${table}.${column}`).sort());
  });

  test("a question delivered again after the PR keeps its ordered delivery past the PR response", () => {
    const { db } = harness();
    waiting(db, "item-q", "ses-q");
    // The PR response is a terminal activity; later critical elicitations are fenced off.
    enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      orderingKey: "ses-q",
      idempotencyKey: "pull-request-ready:item-q",
      payload: { itemId: "item-q", kind: "response", body: "Opened PR #9." },
    });
    const dead = enqueueOutbox(db, {
      target: "linear",
      op: "elicitation",
      orderingKey: "ses-q",
      delivery: "ordered",
      idempotencyKey: "question:q-item-q:redelivery",
      payload: { id: "q-item-q", sessionId: "ses-q", questionId: "q-item-q", body: "Accept?" },
    });
    db.run("UPDATE outbox SET status = 'dead', error = 'Linear is down' WHERE id = ?", [dead]);

    const id = redeliverQuestion(db, "q-item-q", 9_000);

    expect(id).not.toBeNull();
    expect(getOutbox(db, id!)).toMatchObject({
      status: "pending",
      delivery: "ordered",
      idempotencyKey: `question:q-item-q${ELICITATION_REASK_SUFFIX}`,
    });
    expect(getOutbox(db, dead)?.status).toBe("dropped");
    expect(listDeadDeliveries(db, "item-q")).toEqual([]);
  });

  test("a redelivery the session fence rejects leaves the dead row listed for a retry", () => {
    const { db } = harness();
    waiting(db, "item-q", "ses-q");
    const dead = elicit(db, "item-q", "ses-q");
    db.run("UPDATE outbox SET status = 'dead', error = 'Linear is down' WHERE id = ?", [dead]);
    // A terminal response arrived since; a critical elicitation can no longer follow it.
    enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      orderingKey: "ses-q",
      idempotencyKey: "pull-request-ready:item-q",
      payload: { itemId: "item-q", kind: "response", body: "Opened PR #9." },
    });
    db.run("UPDATE outbox SET status = 'dead' WHERE id = ?", [dead]);
    lines = [];

    expect(redeliverQuestion(db, "q-item-q", 9_000)).toBeNull();
    expect(getOutbox(db, dead)?.status).toBe("dead");
    expect(listDeadDeliveries(db, "item-q").map((entry) => [entry.id, entry.retryable])).toEqual([
      [dead, true],
    ]);
    expect(lines.at(-1)).toMatch(
      /^question q-item-q could not be delivered again: .*retry it from the issue page$/,
    );
  });

  test("only a dead final Stop delivery counts as one for a stopped session", () => {
    const { db } = harness();
    waiting(db, "item-q", "ses-q");
    const question = elicit(db, "item-q", "ses-q");
    const stop = enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      orderingKey: "ses-q",
      delivery: "stop",
      idempotencyKey: "stop:item-q",
      payload: { itemId: "item-q", kind: "response", body: "Stopped." },
    });
    db.run("UPDATE outbox SET status = 'dead' WHERE id IN (?, ?)", [question, stop]);
    expect(deadDeliveryIsFinalStop(db, { kind: "outbox", id: stop })).toBe(true);
    expect(deadDeliveryIsFinalStop(db, { kind: "outbox", id: question })).toBe(false);
    expect(deadDeliveryIsFinalStop(db, { kind: "job", id: stop })).toBe(false);
  });
});
