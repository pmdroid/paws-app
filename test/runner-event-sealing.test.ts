import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { and, count, eq, isNull, sql } from "drizzle-orm";
import type { Q } from "../src/db";
import {
  createRunnerWork,
  encryptRunnerEvents,
  RUNNER_EVENT_ENCRYPT_JOB,
} from "../src/runner-work";
import { seed, withoutForeignKeys } from "./dialects";
import { tempStore } from "./pglite";

const open: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

const at = (q: Q, sequence: number) => {
  const e = q.t.runnerEvent;
  return and(eq(e.runId, "run"), eq(e.generation, 1), eq(e.sequence, sequence));
};

async function setup() {
  const { db, close } = await tempStore();
  open.push(close);
  await withoutForeignKeys(db);
  const key = randomBytes(32);
  const work = createRunnerWork({
    store: db,
    keyId: "fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    eventKey: key,
  });
  const insert = (sequence: number, payload: object) =>
    seed(db, (q) =>
      q.orm
        .insert(q.t.runnerEvent)
        .values({ runId: "run", generation: 1, sequence, payload, receivedAt: 0 }),
    );
  const row = async (sequence: number) =>
    (await db.run((q) => {
      const e = q.t.runnerEvent;
      return q.one(
        q.orm
          .select({
            runId: e.runId,
            generation: e.generation,
            sequence: e.sequence,
            payload: sql<string>`${e.payload}::text`,
            keyId: e.keyId,
            payloadSha256: e.payloadSha256,
            type: e.type,
            handedOver: e.handedOver,
            reason: e.reason,
          })
          .from(e)
          .where(at(q, sequence)),
      );
    }))!;
  const enqueue = () =>
    seed(db, (q) =>
      q.orm.insert(q.t.job).values({
        queue: RUNNER_EVENT_ENCRYPT_JOB,
        jobKey: RUNNER_EVENT_ENCRYPT_JOB,
        priority: 9,
        runAt: 0,
        maxAttempts: 1000,
        createdAt: 0,
      }),
    );
  return { db, key, work, insert, row, enqueue };
}

test("the seal job converts plaintext events, resumes after an interruption, then refuses plaintext", async () => {
  const { db, key, work, insert, row, enqueue } = await setup();
  await enqueue();
  await insert(1, { type: "handover", handedOver: false, reason: "timeout" });
  await insert(2, { type: "question", text: "Which fixture?", options: ["A"] });
  for (let sequence = 3; sequence <= 700; sequence++)
    await insert(sequence, { type: "progress", text: `Step ${sequence}` });
  expect(await work.openEvent(await row(3))).toEqual({ type: "progress", text: "Step 3" });

  const interrupted = new AbortController();
  const first = encryptRunnerEvents({ db, key, signal: interrupted.signal });
  interrupted.abort();
  await expect(first).rejects.toThrow();
  const unsealed = async () =>
    (await db.run((q) =>
      q.one(
        q.orm.select({ count: count() }).from(q.t.runnerEvent).where(isNull(q.t.runnerEvent.keyId)),
      ),
    ))!.count;
  expect(await unsealed()).toBe(200);
  expect(await work.openEvent(await row(3))).toEqual({ type: "progress", text: "Step 3" });

  expect(await encryptRunnerEvents({ db, key })).toEqual({ sealed: 200 });
  expect(await unsealed()).toBe(0);
  const handover = await row(1);
  expect(handover.payload).not.toContain("timeout");
  expect([handover.type, handover.handedOver, handover.reason]).toEqual(["handover", 0, "timeout"]);
  expect((await row(2)).type).toBe("question");
  expect((await row(2)).reason).toBeNull();
  expect((await row(700)).payload).not.toContain("Step");
  expect(await work.openEvent(await row(700))).toEqual({ type: "progress", text: "Step 700" });

  await seed(db, (q) =>
    q.orm
      .update(q.t.job)
      .set({ status: "done" })
      .where(eq(q.t.job.jobKey, RUNNER_EVENT_ENCRYPT_JOB)),
  );
  await insert(701, { type: "progress", text: "Plaintext" });
  await expect(work.openEvent(await row(701))).rejects.toThrow(/not sealed/);
});

test("a sealed payload moved to another sequence fails to open", async () => {
  const { db, key, work, insert, row, enqueue } = await setup();
  await enqueue();
  await insert(1, { type: "progress", text: "First" });
  await insert(2, { type: "progress", text: "Second" });
  await encryptRunnerEvents({ db, key });
  const first = await row(1);
  expect(await work.openEvent(first)).toEqual({ type: "progress", text: "First" });
  await seed(db, (q) =>
    q.orm
      .update(q.t.runnerEvent)
      .set({ payload: sql`${first.payload}::jsonb`, payloadSha256: first.payloadSha256 })
      .where(at(q, 2)),
  );
  await expect(work.openEvent(await row(2))).rejects.toThrow();
  const other = createRunnerWork({
    store: db,
    keyId: "fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    eventKey: randomBytes(32),
  });
  await expect(other.openEvent(await row(1))).rejects.toThrow(/another key/);
});
