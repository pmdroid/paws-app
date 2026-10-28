import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createRunFileChunks, RUN_FILE_CHUNK_BYTES, type RunFileObjects } from "../src/run-files";
import {
  createFakeRunnerTranscriptObjects,
  createLocalRunnerTranscriptObjects,
  encryptRunnerTranscripts,
  RUNNER_TRANSCRIPT_ENCRYPT_JOB,
  runnerTranscriptsEncrypted,
} from "../src/runner-transcripts";
import { migrate } from "../src/db";
import { tempDb, tempHome } from "./helpers";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const MARKER = Buffer.from("PLAINTEXT_TRANSCRIPT_MARKER_51c9");
const line = Buffer.concat([MARKER, Buffer.from(` ${"y".repeat(300)}\n`)]);
const first = Buffer.concat(
  Array.from({ length: Math.ceil(RUN_FILE_CHUNK_BYTES / line.length) }, () => line),
).subarray(0, RUN_FILE_CHUNK_BYTES);
const second = Buffer.concat([line, line, line]);
const whole = Buffer.concat([first, second]);
const RUNS = ["run-a", "run-b", "run-c"];
const MIGRATION = "20261028T0150_runner_transcript_encrypt_job";
const prefix = (runId: string) =>
  `paws/transcripts/workspace/command-${runId}/execution-${runId}/chunks`;
const objectName = (runId: string, offset: number, bytes: Buffer) =>
  `${prefix(runId)}/${offset}-${sha(bytes)}`;

class Refused extends Error {}

describe("encrypting runner transcripts stored before encryption", () => {
  let db: Database;
  let key: Buffer;
  let home: string;
  let local: RunFileObjects;
  let remote: ReturnType<typeof createFakeRunnerTranscriptObjects>;

  /**
   * Each run's transcript as PAS-865 found it, chunk rows without a key ID and plaintext objects,
   * before the migration runs.
   */
  beforeEach(async () => {
    db = tempDb();
    db.exec("PRAGMA foreign_keys=OFF");
    key = randomBytes(32);
    home = tempHome();
    local = createLocalRunnerTranscriptObjects(join(home, "runner-transcripts"));
    remote = createFakeRunnerTranscriptObjects();
    for (const runId of RUNS) {
      db.run(
        `INSERT INTO runner_transcript(run_id,generation,command_id,workspace_id,execution_id,
        size_bytes,sealed_size,sha256,uri) VALUES(?,1,?,'workspace',?,?,?,?,'s3://legacy')`,
        [runId, `command-${runId}`, `execution-${runId}`, whole.length, whole.length, sha(whole)],
      );
      for (const [offset, bytes] of [
        [0, first],
        [RUN_FILE_CHUNK_BYTES, second],
      ] as const) {
        db.run(
          `INSERT INTO runner_transcript_chunk(run_id,generation,offset,size_bytes,sha256)
          VALUES(?,1,?,?,?)`,
          [runId, offset, bytes.length, sha(bytes)],
        );
        // run-c was stored in S3; the others in the local directory.
        await (runId === "run-c" ? remote : local).write(objectName(runId, offset, bytes), bytes);
      }
    }
    db.run("DELETE FROM schema_migration WHERE id=?", [MIGRATION]);
    migrate(db);
  });
  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  /** Reads through the local directory, then S3, as Paws does with a bucket configured. */
  const fallback: RunFileObjects = {
    write: (name, bytes) => remote.write(name, bytes),
    read: (name) => local.read(name).catch(() => remote.read(name)),
    delete: async (name) => {
      await local.delete(name);
      await remote.delete(name);
    },
  };
  async function read(runId: string) {
    const files = createRunFileChunks({
      db,
      kind: "transcript",
      objects: fallback,
      key,
      refused: () => {
        throw new Refused();
      },
      plaintext: () => !runnerTranscriptsEncrypted(db),
    });
    const parts: Uint8Array[] = [];
    for await (const part of files.read(
      { runId, generation: 1, prefix: prefix(runId) },
      whole.length,
      sha(whole),
    ))
      parts.push(part);
    return Buffer.concat(parts);
  }
  const unconverted = () =>
    db
      .query<{ count: number }, []>(
        "SELECT count(*) AS count FROM runner_transcript_chunk WHERE key_id IS NULL",
      )
      .get()!.count;
  const finish = () =>
    db.run("UPDATE job SET status='done' WHERE job_key=?", [RUNNER_TRANSCRIPT_ENCRYPT_JOB]);
  function plaintextOnDisk() {
    const directory = join(home, "runner-transcripts");
    return readdirSync(directory).filter(
      (file) => file.endsWith(".tmp") || readFileSync(join(directory, file)).includes(MARKER),
    );
  }

  const jobs = (database: Database) =>
    database
      .query<{ queue: string; status: string }, [string]>(
        "SELECT queue,status FROM job WHERE job_key=?",
      )
      .all(RUNNER_TRANSCRIPT_ENCRYPT_JOB);

  test("the migration enqueues the job once, and plaintext reads until it is done", async () => {
    expect(jobs(db)).toEqual([{ queue: RUNNER_TRANSCRIPT_ENCRYPT_JOB, status: "pending" }]);
    expect(runnerTranscriptsEncrypted(db)).toBe(false);
    expect(await read("run-a")).toEqual(whole);
    finish();
    expect(runnerTranscriptsEncrypted(db)).toBe(true);
    await expect(read("run-a")).rejects.toThrow("Runner transcript storage is unavailable");
  });

  test("a database with no plaintext chunks gets no job", () => {
    const fresh = tempDb();
    try {
      expect(jobs(fresh)).toEqual([]);
      expect(runnerTranscriptsEncrypted(fresh)).toBe(true);
    } finally {
      fresh.close();
    }
  });

  test("plaintext chunks are converted, local and S3, and no plaintext is left on disk", async () => {
    expect(plaintextOnDisk()).toHaveLength(4);
    const result = await encryptRunnerTranscripts({ db, stores: [local, remote], key });
    expect(result).toEqual({ converted: 6, skipped: 0 });
    expect(unconverted()).toBe(0);
    expect(plaintextOnDisk()).toEqual([]);
    expect(readdirSync(join(home, "runner-transcripts"))).toHaveLength(4);
    for (const bytes of remote.objects.values())
      expect(Buffer.from(bytes).includes(MARKER)).toBe(false);
    finish();
    for (const runId of RUNS) expect(await read(runId)).toEqual(whole);
  });

  test("an interrupted conversion resumes and the transcript reads the same throughout", async () => {
    const before = await Promise.all(RUNS.map(read));
    expect(before.every((bytes) => bytes.equals(whole))).toBe(true);

    // The process stops after the third object is sealed, before its key ID is recorded.
    let writes = 0;
    const stopping: RunFileObjects = {
      ...local,
      read: (name) => local.read(name),
      delete: (name) => local.delete(name),
      async write(name, bytes) {
        await local.write(name, bytes);
        if (++writes === 3) throw new Error("Paws stopped");
      },
    };
    await expect(encryptRunnerTranscripts({ db, stores: [stopping, remote], key })).rejects.toThrow(
      "Paws stopped",
    );
    expect(unconverted()).toBe(4);
    for (const runId of RUNS) expect(await read(runId)).toEqual(whole);

    // A stop requested between chunks also leaves the rest for the next run.
    const abort = new AbortController();
    abort.abort();
    await expect(
      encryptRunnerTranscripts({ db, stores: [local, remote], key, signal: abort.signal }),
    ).rejects.toThrow();
    expect(unconverted()).toBe(4);

    const result = await encryptRunnerTranscripts({ db, stores: [local, remote], key });
    expect(result).toEqual({ converted: 4, skipped: 0 });
    expect(unconverted()).toBe(0);
    expect(plaintextOnDisk()).toEqual([]);
    for (const runId of RUNS) expect(await read(runId)).toEqual(whole);
    finish();
    for (const runId of RUNS) expect(await read(runId)).toEqual(whole);
  });

  test("a read that began before its chunk was sealed still returns the transcript", async () => {
    const files = createRunFileChunks({
      db,
      kind: "transcript",
      objects: local,
      key,
      refused: () => {
        throw new Refused();
      },
      plaintext: () => !runnerTranscriptsEncrypted(db),
    });
    const reading = files.read(
      { runId: "run-a", generation: 1, prefix: prefix("run-a") },
      whole.length,
      sha(whole),
    );
    // The reader has its chunk rows, without key IDs, when the job seals the objects.
    const parts = [(await reading.next()).value!];
    await encryptRunnerTranscripts({ db, stores: [local], key });
    expect(unconverted()).toBe(2);
    for await (const part of reading) parts.push(part);
    expect(Buffer.concat(parts)).toEqual(whole);
  });

  test("after the job is done, a chunk without a key ID is refused", async () => {
    await encryptRunnerTranscripts({ db, stores: [local, remote], key });
    finish();
    db.run("UPDATE runner_transcript_chunk SET key_id=NULL WHERE run_id='run-a'");
    await local.write(objectName("run-a", 0, first), first);
    await expect(read("run-a")).rejects.toThrow("Runner transcript storage is unavailable");
  });

  test("a chunk with no readable copy is left for reads to refuse, and the job still ends", async () => {
    await local.delete(objectName("run-b", RUN_FILE_CHUNK_BYTES, second));
    const result = await encryptRunnerTranscripts({ db, stores: [local, remote], key });
    expect(result).toEqual({ converted: 5, skipped: 1 });
    expect(unconverted()).toBe(1);
  });
});
