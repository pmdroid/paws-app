import type { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { loadSecretKey } from "../credentials";
import { plaintextRunnerEventsSteps, sealRunnerEventSteps, sqliteDb } from "../db";
import { RunnerEventSchema, type RunnerEvent } from "../runner-protocol";
import { incrementalVacuum } from "./prune";

export const RUNNER_EVENT_KEY_FILE = "runner-event.key";
const KEY_CONTEXT = "paws-runner-event-key\0";

export const RUNNER_EVENT_ENCRYPT_JOB = "runner-events.encrypt";

export const loadRunnerEventKey = (path: string) => loadSecretKey(path, "Runner event");

export function runnerEventKeyId(key: Buffer) {
  return createHash("sha256").update(KEY_CONTEXT).update(key).digest("hex");
}

export function runnerEventsEncrypted(db: Database) {
  const job = db
    .query<{ status: string }, [string]>("SELECT status FROM job WHERE job_key=?")
    .get(RUNNER_EVENT_ENCRYPT_JOB);
  return !job || job.status === "done";
}

export type StoredRunnerEvent = {
  runId: string;
  generation: number;
  sequence: number;
  payload: string;
  keyId: string | null;
  payloadSha256: string | null;
};
export const RUNNER_EVENT_COLUMNS =
  "run_id AS runId,generation,sequence,payload,key_id AS keyId,payload_sha256 AS payloadSha256";

type Binding = { runId: string; generation: number; sequence: number; sha256: string };

export const payloadSha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function additionalData(binding: Binding) {
  return Buffer.from(
    `${binding.runId}|${binding.generation}|${binding.sequence}|${binding.sha256}`,
    "utf8",
  );
}

export function sealRunnerEvent(
  key: Buffer,
  row: { runId: string; generation: number; sequence: number },
  text: string,
) {
  const sha256 = payloadSha256(text);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(additionalData({ ...row, sha256 }));
  const ciphertext = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const event = JSON.parse(text) as { type?: unknown; handedOver?: unknown; reason?: unknown };
  const handover = event.type === "handover" || event.type === "handover_interrupted";
  return {
    payload: JSON.stringify(
      Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64"),
    ),
    keyId: runnerEventKeyId(key),
    payloadSha256: sha256,
    type: typeof event.type === "string" ? event.type : null,
    handedOver: handover && typeof event.handedOver === "boolean" ? Number(event.handedOver) : null,
    reason: handover && typeof event.reason === "string" ? event.reason : null,
  };
}

export function openRunnerEvent(db: Database, key: Buffer, row: StoredRunnerEvent): RunnerEvent {
  if (row.keyId === null) {
    if (runnerEventsEncrypted(db)) throw new Error("Runner event is not sealed.");
    return RunnerEventSchema.parse(JSON.parse(row.payload));
  }
  if (row.keyId !== runnerEventKeyId(key) || row.payloadSha256 === null)
    throw new Error("Runner event was sealed under another key.");
  const bytes = Buffer.from(JSON.parse(row.payload) as string, "base64");
  if (bytes.length < 28) throw new Error("Runner event is truncated.");
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  decipher.setAAD(additionalData({ ...row, sha256: row.payloadSha256 }));
  decipher.setAuthTag(bytes.subarray(12, 28));
  const text = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(
    "utf8",
  );
  if (payloadSha256(text) !== row.payloadSha256) throw new Error("Runner event hash differs.");
  return RunnerEventSchema.parse(JSON.parse(text));
}

const BATCH = 500;

export async function encryptRunnerEvents(options: {
  db: Database;
  key: Buffer;
  signal?: AbortSignal;
}) {
  const { db, key, signal } = options;
  const store = sqliteDb(db);
  let after: [string, number, number] = ["", 0, 0];
  let sealed = 0;
  // Zero the plaintext that sealing frees, without rebuilding the file. Bytes left in the slack of
  // pages that split stay until the offline rebuild in the README.
  const mode = db.query<{ secure_delete: number }, []>("PRAGMA secure_delete").get()?.secure_delete;
  const secureDelete = mode === 2 ? "FAST" : mode ? "ON" : "OFF";
  db.run("PRAGMA secure_delete=ON");
  try {
    for (;;) {
      signal?.throwIfAborted();
      const from = after;
      const rows = await store.transaction(function* (q) {
        const batch = yield* plaintextRunnerEventsSteps(q, from, BATCH);
        for (const row of batch)
          yield* sealRunnerEventSteps(q, row, sealRunnerEvent(key, row, row.payload));
        return batch;
      });
      const last = rows.at(-1);
      if (!last) break;
      after = [last.runId, last.generation, last.sequence];
      sealed += rows.length;
      await yieldToLoop();
    }
    incrementalVacuum(db);
    const [checkpoint] = db.query<{ busy: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)").all();
    if (checkpoint?.busy) throw new Error("Runner event WAL checkpoint is busy.");
  } finally {
    db.run(`PRAGMA secure_delete=${secureDelete}`);
  }
  return { sealed };
}
