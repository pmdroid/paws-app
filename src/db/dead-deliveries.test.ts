import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, inArray, is, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { FakeClock, JOB_KIND } from "../core";
import {
  DEFAULT_OUTBOX_MAX_ATTEMPTS,
  ELICITATION_REASK_SUFFIX,
  OutboxDispatcher,
  QUESTION_LINKS,
  deadDeliveryIsFinalStop,
  getOutboxSteps,
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
  recordQuestionReask,
  retryDeadDelivery,
  setJournalSink,
  pgSchema,
  type Db,
} from "./index";
import { seed } from "../../test/dialects";
import { tempStore } from "../../test/pglite";

type ItemState = "awaiting_input" | "running";

function setItemState(db: Db, id: string, state: ItemState) {
  return seed(db, (q) => q.orm.update(q.t.workItem).set({ state }).where(eq(q.t.workItem.id, id)));
}

function addQuestion(db: Db, id: string, itemId: string, sessionId: string, body: string) {
  return seed(db, (q) =>
    q.orm
      .insert(q.t.question)
      .values({ id, itemId, sessionId, body, status: "open", createdAt: 0 }),
  );
}

function markDead(db: Db, ids: number[], error?: string) {
  return seed(db, (q) =>
    q.orm
      .update(q.t.outbox)
      .set({ status: "dead", ...(error === undefined ? {} : { error }) })
      .where(inArray(q.t.outbox.id, ids)),
  );
}

let lines: string[] = [];
let restore: () => void = () => {};
beforeEach(() => {
  lines = [];
  restore = setJournalSink((line) => lines.push(line));
});
afterEach(() => restore());

async function harness() {
  const clock = new FakeClock(5_000);
  const db = (await tempStore()).db;
  const dispatcher = new OutboxDispatcher(db, clock, { backoffBaseMs: 1_000 });
  return { clock, db, dispatcher };
}

async function waiting(db: Db, id: string, session: string): Promise<void> {
  await insertQueuedItem(db, { id, sessionKey: session });
  await setItemState(db, id, "awaiting_input");
  await addQuestion(db, `q-${id}`, id, session, "Which repository?");
}

async function elicit(db: Db, id: string, session: string): Promise<number> {
  return await enqueueOutbox(db, {
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
    await dispatcher.tick();
    await dispatcher.idle();
    clock.advance(60_000);
  }
}

describe("dead outbox rows and jobs", () => {
  test("a dead row writes one journal line with the item, the kind and the last error", async () => {
    const { clock, db, dispatcher } = await harness();
    await insertQueuedItem(db, { id: "item-a", sessionKey: "ses-a" });
    await enqueueOutbox(db, {
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

  test("a dead job writes one journal line whatever its queue", async () => {
    const { db } = await harness();
    await enqueueJob(db, {
      queue: JOB_KIND.catchup,
      payload: { itemId: "item-a" },
      maxAttempts: 1,
      now: 0,
    });
    const job = await claimNextJob(db, {
      workerId: "w",
      now: 1_000,
      queues: [JOB_KIND.catchup],
    });
    await failJob(db, job!, new Error("gone"), { now: 1_000 });
    expect(lines.filter((line) => line.startsWith("job "))).toEqual([
      `job 1 ${JOB_KIND.catchup} dead item=item-a attempts=1/1 error=gone`,
    ]);
  });

  test("a dead elicitation of a waiting item is re-enqueued once, then re-asked", async () => {
    const { clock, db, dispatcher } = await harness();
    await waiting(db, "item-q", "ses-q");
    await elicit(db, "item-q", "ses-q");
    const posted: string[] = [];
    dispatcher.setHandler((row) => {
      posted.push(row.idempotencyKey);
      throw new Error("Linear is down");
    });
    await deliverAll(dispatcher, clock, 10);

    const rows = await listOutbox(db, "ses-q");
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
    expect((await listDeadDeliveries(db, "item-q")).map((dead) => [dead.kind, dead.id])).toEqual([
      ["outbox", 2],
    ]);
    const reask = (await listJobs(db)).filter((job) => job.queue === JOB_KIND.reaskQuestion);
    expect(reask.map((job) => [job.jobKey, job.payload])).toEqual([
      [`${JOB_KIND.reaskQuestion}:q-item-q`, { itemId: "item-q", questionId: "q-item-q" }],
    ]);
  });

  test("each question gets its own re-ask, and a re-asked question does not get another", async () => {
    const { clock, db, dispatcher } = await harness();
    await waiting(db, "item-q", "ses-q");
    dispatcher.setHandler(() => {
      throw new Error("Linear is down");
    });
    const question = async (id: string) => {
      await addQuestion(db, id, "item-q", "ses-q", "And the branch?");
      await enqueueOutbox(db, {
        target: "linear",
        op: "elicitation",
        orderingKey: "ses-q",
        idempotencyKey: `question:${id}`,
        payload: { id, sessionId: "ses-q", questionId: id, body: "And the branch?" },
        maxAttempts: 1,
      });
    };
    const reasks = async () =>
      (await listJobs(db))
        .filter((job) => job.queue === JOB_KIND.reaskQuestion)
        .map((job) => job.jobKey);
    // A question that is answered drops its dead rows (answerQuestion does this in src/questions).
    const settle = (id: string) =>
      seed(
        db,
        (q) =>
          q.orm.update(q.t.question).set({ status: "answered" }).where(eq(q.t.question.id, id)),
        (q) =>
          q.orm.update(q.t.outbox).set({ status: "dropped" }).where(eq(q.t.outbox.status, "dead")),
      );

    await elicit(db, "item-q", "ses-q");
    await deliverAll(dispatcher, clock, 10);
    await settle("q-item-q");
    // A later, independent question in the same run still gets its own re-ask.
    await question("q2");
    await deliverAll(dispatcher, clock, 10);
    expect(await reasks()).toEqual([
      `${JOB_KIND.reaskQuestion}:q-item-q`,
      `${JOB_KIND.reaskQuestion}:q2`,
    ]);

    // The loop re-asked q2 as q3. When q3 dies twice too, it shares q2's allowance.
    const q2Job = (await listJobs(db)).find(
      (job) => job.jobKey === `${JOB_KIND.reaskQuestion}:q2`,
    )!;
    await recordQuestionReask(db, q2Job.id, "q3");
    await settle("q2");
    await question("q3");
    lines = [];
    await deliverAll(dispatcher, clock, 10);
    expect(await reasks()).toHaveLength(2);
    expect(lines.filter((line) => line.startsWith("outbox ")).at(-1)).toMatch(
      /^outbox \d+ elicitation dead again item=item-q; retry it from the issue page$/,
    );

    // A question kept by id is delivered again under :reask; when that dies, it stays dead.
    await settle("q3");
    await addQuestion(db, "q4", "item-q", "ses-q", "Accept?");
    const reaskJob = await enqueueJob(db, {
      queue: JOB_KIND.reaskQuestion,
      jobKey: `${JOB_KIND.reaskQuestion}:q4`,
      payload: { itemId: "item-q", questionId: "q4", reaskedAs: "q4" },
    });
    await enqueueOutbox(db, {
      target: "linear",
      op: "elicitation",
      orderingKey: "ses-q",
      idempotencyKey: `question:q4${ELICITATION_REASK_SUFFIX}`,
      payload: { id: "q4", sessionId: "ses-q", questionId: "q4", body: "Accept?" },
      maxAttempts: 1,
    });
    await deliverAll(dispatcher, clock, 10);
    expect(
      (await listOutbox(db, "ses-q"))
        .filter((row) => row.idempotencyKey.startsWith("question:q4"))
        .map((row) => [row.idempotencyKey, row.status]),
    ).toEqual([[`question:q4${ELICITATION_REASK_SUFFIX}`, "dead"]]);
    expect(await reasks()).toHaveLength(3);
    expect((await getJob(db, reaskJob))?.status).toBe("pending");
  });

  test("the re-enqueued elicitation is delivered when Linear recovers", async () => {
    const { clock, db, dispatcher } = await harness();
    await waiting(db, "item-q", "ses-q");
    await elicit(db, "item-q", "ses-q");
    let fail = true;
    dispatcher.setHandler(() => {
      if (fail) {
        fail = false;
        throw new Error("timeout");
      }
    });
    await deliverAll(dispatcher, clock);
    expect((await listOutbox(db, "ses-q")).map((row) => row.status)).toEqual(["dropped", "sent"]);
  });

  test("an elicitation for an item that no longer waits stays dead", async () => {
    const { clock, db, dispatcher } = await harness();
    await waiting(db, "item-q", "ses-q");
    await setItemState(db, "item-q", "running");
    await elicit(db, "item-q", "ses-q");
    dispatcher.setHandler(() => {
      throw new Error("timeout");
    });
    await deliverAll(dispatcher, clock);
    expect((await listOutbox(db, "ses-q")).map((row) => row.status)).toEqual(["dead"]);
  });

  test("an answered question's elicitation is not re-enqueued", async () => {
    const { clock, db, dispatcher } = await harness();
    await waiting(db, "item-q", "ses-q");
    await seed(db, (q) =>
      q.orm.update(q.t.question).set({ status: "answered" }).where(eq(q.t.question.id, "q-item-q")),
    );
    await elicit(db, "item-q", "ses-q");
    dispatcher.setHandler(() => {
      throw new Error("timeout");
    });
    await deliverAll(dispatcher, clock);
    expect((await listOutbox(db, "ses-q")).map((row) => row.status)).toEqual(["dead"]);
  });

  test("retry puts a dead row or job of the item back to pending", async () => {
    const { clock, db, dispatcher } = await harness();
    await waiting(db, "item-q", "ses-q");
    await setItemState(db, "item-q", "running");
    await elicit(db, "item-q", "ses-q");
    dispatcher.setHandler(() => {
      throw new Error("timeout");
    });
    await deliverAll(dispatcher, clock);
    await enqueueJob(db, {
      queue: JOB_KIND.resume,
      payload: { itemId: "item-q" },
      maxAttempts: 1,
    });
    const job = await claimNextJob(db, { workerId: "w", queues: [JOB_KIND.resume] });
    await failJob(db, job!, new Error("runner lost"));
    expect((await listDeadDeliveries(db, "item-q")).map((dead) => [dead.kind, dead.name])).toEqual([
      ["outbox", "linear.elicitation"],
      ["job", JOB_KIND.resume],
    ]);

    expect(await retryDeadDelivery(db, "other", { kind: "job", id: job!.id })).toBe(false);
    expect((await listDeadDeliveries(db, "item-q")).map((dead) => dead.retryable)).toEqual([
      true,
      true,
    ]);
    expect(await retryDeadDelivery(db, "item-q", { kind: "job", id: job!.id })).toBe(true);
    expect((await getJob(db, job!.id))?.status).toBe("pending");
    expect(await jobVersionCurrent(db, job!)).toBe(true);
    expect(await retryDeadDelivery(db, "item-q", { kind: "outbox", id: 1 }, clock.now())).toBe(
      true,
    );
    expect(await listDeadDeliveries(db, "item-q")).toEqual([]);

    dispatcher.setHandler(() => {});
    await deliverAll(dispatcher, clock, 1);
    expect((await listOutbox(db, "ses-q")).map((row) => row.status)).toEqual(["sent"]);
    expect(lines).toContain("outbox 1 retried item=item-q");
  });

  test("a dead job from an earlier item version is listed but never retried", async () => {
    const { db } = await harness();
    await waiting(db, "item-q", "ses-q");
    await enqueueJob(db, {
      queue: JOB_KIND.resume,
      payload: { itemId: "item-q" },
      maxAttempts: 1,
    });
    const job = await claimNextJob(db, { workerId: "w", queues: [JOB_KIND.resume] });
    await failJob(db, job!, new Error("runner lost"));
    // A restart, answer or stop moved the item on; the job's payload is now obsolete.
    await seed(db, (q) =>
      q.orm
        .update(q.t.workItem)
        .set({ version: sql`${q.t.workItem.version} + 1` })
        .where(eq(q.t.workItem.id, "item-q")),
    );

    expect(
      (await listDeadDeliveries(db, "item-q")).map((dead) => [dead.kind, dead.retryable]),
    ).toEqual([["job", false]]);
    expect(await retryDeadDelivery(db, "item-q", { kind: "job", id: job!.id })).toBe(false);
    expect((await getJob(db, job!.id))?.status).toBe("dead");
    expect(await jobVersionCurrent(db, job!)).toBe(false);
  });

  test("every question id column in the schema is a known question link", async () => {
    const links = Object.values(pgSchema)
      .filter((table) => is(table, PgTable))
      .flatMap((table) => {
        const { name, columns } = getTableConfig(table);
        return columns
          .filter((column) => column.name.endsWith("question_id"))
          .map((column) => `${name}.${column.name}`);
      })
      .sort();
    expect(links).toEqual(QUESTION_LINKS.map(({ table, column }) => `${table}.${column}`).sort());
  });

  test("a question delivered again after the PR keeps its ordered delivery past the PR response", async () => {
    const { db } = await harness();
    await waiting(db, "item-q", "ses-q");
    // The PR response is a terminal activity; later critical elicitations are fenced off.
    await enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      orderingKey: "ses-q",
      idempotencyKey: "pull-request-ready:item-q",
      payload: { itemId: "item-q", kind: "response", body: "Opened PR #9." },
    });
    const dead = await enqueueOutbox(db, {
      target: "linear",
      op: "elicitation",
      orderingKey: "ses-q",
      delivery: "ordered",
      idempotencyKey: "question:q-item-q:redelivery",
      payload: { id: "q-item-q", sessionId: "ses-q", questionId: "q-item-q", body: "Accept?" },
    });
    await markDead(db, [dead], "Linear is down");

    const id = await redeliverQuestion(db, "q-item-q", 9_000);

    expect(id).not.toBeNull();
    expect(await db.run((q) => getOutboxSteps(q, id!))).toMatchObject({
      status: "pending",
      delivery: "ordered",
      idempotencyKey: `question:q-item-q${ELICITATION_REASK_SUFFIX}`,
    });
    expect((await db.run((q) => getOutboxSteps(q, dead)))?.status).toBe("dropped");
    expect(await listDeadDeliveries(db, "item-q")).toEqual([]);
  });

  test("a redelivery the session fence rejects leaves the dead row listed for a retry", async () => {
    const { db } = await harness();
    await waiting(db, "item-q", "ses-q");
    const dead = await elicit(db, "item-q", "ses-q");
    await markDead(db, [dead], "Linear is down");
    // A terminal response arrived since; a critical elicitation can no longer follow it.
    await enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      orderingKey: "ses-q",
      idempotencyKey: "pull-request-ready:item-q",
      payload: { itemId: "item-q", kind: "response", body: "Opened PR #9." },
    });
    await markDead(db, [dead]);
    lines = [];

    expect(await redeliverQuestion(db, "q-item-q", 9_000)).toBeNull();
    expect((await db.run((q) => getOutboxSteps(q, dead)))?.status).toBe("dead");
    expect(
      (await listDeadDeliveries(db, "item-q")).map((entry) => [entry.id, entry.retryable]),
    ).toEqual([[dead, true]]);
    expect(lines.at(-1)).toMatch(
      /^question q-item-q could not be delivered again: .*retry it from the issue page$/,
    );
  });

  test("only a dead final Stop delivery counts as one for a stopped session", async () => {
    const { db } = await harness();
    await waiting(db, "item-q", "ses-q");
    const question = await elicit(db, "item-q", "ses-q");
    const stop = await enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      orderingKey: "ses-q",
      delivery: "stop",
      idempotencyKey: "stop:item-q",
      payload: { itemId: "item-q", kind: "response", body: "Stopped." },
    });
    await markDead(db, [question, stop]);
    expect(await deadDeliveryIsFinalStop(db, { kind: "outbox", id: stop })).toBe(true);
    expect(await deadDeliveryIsFinalStop(db, { kind: "outbox", id: question })).toBe(false);
    expect(await deadDeliveryIsFinalStop(db, { kind: "job", id: stop })).toBe(false);
  });
});
