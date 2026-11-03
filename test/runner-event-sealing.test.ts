import { expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDatabase } from "../src/db";
import {
  createRunnerWork,
  encryptRunnerEvents,
  RUNNER_EVENT_COLUMNS,
  RUNNER_EVENT_ENCRYPT_JOB,
  type StoredRunnerEvent,
} from "../src/runner-work";

function setup(path = ":memory:") {
  const db = openDatabase(path);
  migrate(db);
  db.run("PRAGMA foreign_keys=OFF");
  const key = randomBytes(32);
  const work = createRunnerWork({
    db,
    keyId: "fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    eventKey: key,
  });
  const insert = (sequence: number, event: object) =>
    db.run(
      "INSERT INTO runner_event(run_id,generation,sequence,payload,received_at) VALUES(?,?,?,?,?)",
      ["run", 1, sequence, JSON.stringify(event), 0],
    );
  const row = (sequence: number) =>
    db
      .query<
        StoredRunnerEvent & {
          type: string | null;
          handedOver: number | null;
          reason: string | null;
        },
        [number]
      >(
        `SELECT ${RUNNER_EVENT_COLUMNS},type,handed_over AS handedOver,reason FROM runner_event
         WHERE run_id='run' AND generation=1 AND sequence=?`,
      )
      .get(sequence)!;
  const enqueue = () =>
    db.run(
      "INSERT INTO job(queue,job_key,priority,run_at,max_attempts,created_at) VALUES(?,?,9,0,1000,0)",
      [RUNNER_EVENT_ENCRYPT_JOB, RUNNER_EVENT_ENCRYPT_JOB],
    );
  return { db, key, work, insert, row, enqueue };
}

test("the seal job converts plaintext events, resumes after an interruption, then refuses plaintext", async () => {
  const { db, key, work, insert, row, enqueue } = setup();
  enqueue();
  insert(1, { type: "handover", handedOver: false, reason: "timeout" });
  insert(2, { type: "question", text: "Which fixture?", options: ["A"] });
  for (let sequence = 3; sequence <= 700; sequence++)
    insert(sequence, { type: "progress", text: `Step ${sequence}` });
  expect(work.openEvent(row(3))).toEqual({ type: "progress", text: "Step 3" });

  const interrupted = new AbortController();
  const first = encryptRunnerEvents({ db, key, signal: interrupted.signal });
  interrupted.abort();
  await expect(first).rejects.toThrow();
  const unsealed = () =>
    db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM runner_event WHERE key_id IS NULL",
      )
      .get()!.count;
  expect(unsealed()).toBe(200);
  expect(work.openEvent(row(3))).toEqual({ type: "progress", text: "Step 3" });

  expect(await encryptRunnerEvents({ db, key })).toEqual({ sealed: 200 });
  expect(unsealed()).toBe(0);
  const handover = row(1);
  expect(handover.payload).not.toContain("timeout");
  expect([handover.type, handover.handedOver, handover.reason]).toEqual(["handover", 0, "timeout"]);
  expect(row(2).type).toBe("question");
  expect(row(2).reason).toBeNull();
  expect(row(700).payload).not.toContain("Step");
  expect(work.openEvent(row(700))).toEqual({ type: "progress", text: "Step 700" });

  db.run("UPDATE job SET status='done' WHERE job_key=?", [RUNNER_EVENT_ENCRYPT_JOB]);
  insert(701, { type: "progress", text: "Plaintext" });
  expect(() => work.openEvent(row(701))).toThrow(/not sealed/);
});

test("a sealed payload moved to another sequence fails to open", async () => {
  const { db, key, work, insert, row, enqueue } = setup();
  enqueue();
  insert(1, { type: "progress", text: "First" });
  insert(2, { type: "progress", text: "Second" });
  await encryptRunnerEvents({ db, key });
  const first = row(1);
  expect(work.openEvent(first)).toEqual({ type: "progress", text: "First" });
  db.run(
    "UPDATE runner_event SET payload=?,payload_sha256=? WHERE run_id='run' AND generation=1 AND sequence=2",
    [first.payload, first.payloadSha256],
  );
  expect(() => work.openEvent(row(2))).toThrow();
  const other = createRunnerWork({
    db,
    keyId: "fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    eventKey: randomBytes(32),
  });
  expect(() => other.openEvent(row(1))).toThrow(/another key/);
});

test("sealing leaves no plaintext in the database file or its WAL", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-event-"));
  try {
    const path = join(root, "paws.sqlite");
    const { db, key, insert, enqueue } = setup(path);
    enqueue();
    const marker = "plaintext-marker-6f1c";
    insert(1, { type: "progress", text: `${marker} `.repeat(4000) });
    for (let sequence = 2; sequence <= 40; sequence++)
      insert(sequence, { type: "progress", text: `${marker} ${sequence}` });
    await encryptRunnerEvents({ db, key });
    expect(Buffer.from(db.serialize()).includes(marker)).toBe(false);
    db.close();
    for (const file of [path, `${path}-wal`])
      if (existsSync(file)) expect(readFileSync(file).includes(marker)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
