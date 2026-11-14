import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, isNull } from "drizzle-orm";
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
import type { Db } from "../src/db";
import { seed, withoutForeignKeys } from "./dialects";
import { tempHome } from "./helpers";
import { tempStore } from "./pglite";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const MARKER = Buffer.from("PLAINTEXT_TRANSCRIPT_MARKER_51c9");
const line = Buffer.concat([MARKER, Buffer.from(` ${"y".repeat(300)}\n`)]);
const first = Buffer.concat(
  Array.from({ length: Math.ceil(RUN_FILE_CHUNK_BYTES / line.length) }, () => line),
).subarray(0, RUN_FILE_CHUNK_BYTES);
const second = Buffer.concat([line, line, line]);
const whole = Buffer.concat([first, second]);
const RUNS = ["run-a", "run-b", "run-c"];
const prefix = (runId: string) =>
  `paws/transcripts/workspace/command-${runId}/execution-${runId}/chunks`;
const objectName = (runId: string, offset: number, bytes: Buffer) =>
  `${prefix(runId)}/${offset}-${sha(bytes)}`;

class Refused extends Error {}

describe("encrypting runner transcripts stored before encryption", () => {
  let db: Db;
  let close: () => Promise<void>;
  let key: Buffer;
  let home: string;
  let local: RunFileObjects;
  let remote: ReturnType<typeof createFakeRunnerTranscriptObjects>;

  /**
   * Each run's transcript as PAS-865 found it, chunk rows without a key ID and plaintext objects,
   * with the job the migration enqueues still pending.
   */
  beforeEach(async () => {
    ({ db, close } = await tempStore());
    await withoutForeignKeys(db);
    key = randomBytes(32);
    home = tempHome();
    local = createLocalRunnerTranscriptObjects(join(home, "runner-transcripts"));
    remote = createFakeRunnerTranscriptObjects();
    for (const runId of RUNS) {
      await seed(db, (q) =>
        q.orm.insert(q.t.runnerTranscript).values({
          runId,
          generation: 1,
          commandId: `command-${runId}`,
          workspaceId: "workspace",
          executionId: `execution-${runId}`,
          sizeBytes: whole.length,
          sealedSize: whole.length,
          sha256: sha(whole),
          uri: "s3://legacy",
        }),
      );
      for (const [offset, bytes] of [
        [0, first],
        [RUN_FILE_CHUNK_BYTES, second],
      ] as const) {
        await seed(db, (q) =>
          q.orm
            .insert(q.t.runnerTranscriptChunk)
            .values({ runId, generation: 1, offset, sizeBytes: bytes.length, sha256: sha(bytes) }),
        );
        // run-c was stored in S3; the others in the local directory.
        await (runId === "run-c" ? remote : local).write(objectName(runId, offset, bytes), bytes);
      }
    }
    await seed(db, (q) =>
      q.orm.insert(q.t.job).values({
        queue: RUNNER_TRANSCRIPT_ENCRYPT_JOB,
        jobKey: RUNNER_TRANSCRIPT_ENCRYPT_JOB,
        priority: 9,
        runAt: Date.now(),
        maxAttempts: 1000,
        createdAt: Date.now(),
      }),
    );
  });
  afterEach(async () => {
    await close();
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
      store: db,
      kind: "transcript",
      objects: fallback,
      key,
      refused: () => {
        throw new Refused();
      },
      plaintext: async () => !(await runnerTranscriptsEncrypted(db)),
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
  const unconverted = async () =>
    (
      await db.run((q) =>
        q.all(
          q.orm
            .select({ runId: q.t.runnerTranscriptChunk.runId })
            .from(q.t.runnerTranscriptChunk)
            .where(isNull(q.t.runnerTranscriptChunk.keyId)),
        ),
      )
    ).length;
  const finish = () =>
    seed(db, (q) =>
      q.orm
        .update(q.t.job)
        .set({ status: "done" })
        .where(eq(q.t.job.jobKey, RUNNER_TRANSCRIPT_ENCRYPT_JOB)),
    );
  function plaintextOnDisk() {
    const directory = join(home, "runner-transcripts");
    return readdirSync(directory).filter(
      (file) => file.endsWith(".tmp") || readFileSync(join(directory, file)).includes(MARKER),
    );
  }

  test("plaintext reads until the job is done", async () => {
    expect(await runnerTranscriptsEncrypted(db)).toBe(false);
    expect(await read("run-a")).toEqual(whole);
    await finish();
    expect(await runnerTranscriptsEncrypted(db)).toBe(true);
    await expect(read("run-a")).rejects.toThrow("Runner transcript storage is unavailable");
  });

  test("plaintext chunks are converted, local and S3, and no plaintext is left on disk", async () => {
    expect(plaintextOnDisk()).toHaveLength(4);
    const result = await encryptRunnerTranscripts({
      store: db,
      stores: [local, remote],
      key,
    });
    expect(result).toEqual({ converted: 6, skipped: 0 });
    expect(await unconverted()).toBe(0);
    expect(plaintextOnDisk()).toEqual([]);
    expect(readdirSync(join(home, "runner-transcripts"))).toHaveLength(4);
    for (const bytes of remote.objects.values())
      expect(Buffer.from(bytes).includes(MARKER)).toBe(false);
    await finish();
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
    await expect(
      encryptRunnerTranscripts({ store: db, stores: [stopping, remote], key }),
    ).rejects.toThrow("Paws stopped");
    expect(await unconverted()).toBe(4);
    for (const runId of RUNS) expect(await read(runId)).toEqual(whole);

    // A stop requested between chunks also leaves the rest for the next run.
    const abort = new AbortController();
    abort.abort();
    await expect(
      encryptRunnerTranscripts({
        store: db,
        stores: [local, remote],
        key,
        signal: abort.signal,
      }),
    ).rejects.toThrow();
    expect(await unconverted()).toBe(4);

    const result = await encryptRunnerTranscripts({
      store: db,
      stores: [local, remote],
      key,
    });
    expect(result).toEqual({ converted: 4, skipped: 0 });
    expect(await unconverted()).toBe(0);
    expect(plaintextOnDisk()).toEqual([]);
    for (const runId of RUNS) expect(await read(runId)).toEqual(whole);
    await finish();
    for (const runId of RUNS) expect(await read(runId)).toEqual(whole);
  });

  test("a read that began before its chunk was sealed still returns the transcript", async () => {
    const files = createRunFileChunks({
      store: db,
      kind: "transcript",
      objects: local,
      key,
      refused: () => {
        throw new Refused();
      },
      plaintext: async () => !(await runnerTranscriptsEncrypted(db)),
    });
    const reading = files.read(
      { runId: "run-a", generation: 1, prefix: prefix("run-a") },
      whole.length,
      sha(whole),
    );
    // The reader has its chunk rows, without key IDs, when the job seals the objects.
    const parts = [(await reading.next()).value!];
    await encryptRunnerTranscripts({ store: db, stores: [local], key });
    expect(await unconverted()).toBe(2);
    for await (const part of reading) parts.push(part);
    expect(Buffer.concat(parts)).toEqual(whole);
  });

  test("after the job is done, a chunk without a key ID is refused", async () => {
    await encryptRunnerTranscripts({ store: db, stores: [local, remote], key });
    await finish();
    await seed(db, (q) =>
      q.orm
        .update(q.t.runnerTranscriptChunk)
        .set({ keyId: null })
        .where(eq(q.t.runnerTranscriptChunk.runId, "run-a")),
    );
    await local.write(objectName("run-a", 0, first), first);
    await expect(read("run-a")).rejects.toThrow("Runner transcript storage is unavailable");
  });

  test("a chunk with no readable copy is left for reads to refuse, and the job still ends", async () => {
    await local.delete(objectName("run-b", RUN_FILE_CHUNK_BYTES, second));
    const result = await encryptRunnerTranscripts({
      store: db,
      stores: [local, remote],
      key,
    });
    expect(result).toEqual({ converted: 5, skipped: 1 });
    expect(await unconverted()).toBe(1);
  });
});
