import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  createFakeRunFileObjects,
  createRunFileChunks,
  loadRunFileKey,
  RUN_FILE_CHUNK_BYTES,
  RUN_FILE_KINDS,
  RunFileStorageError,
  runFileKeyId,
} from "../src/run-files";
import type { Db, Q } from "../src/db";
import { withoutForeignKeys } from "./dialects";
import { tempHome } from "./helpers";
import { tempStore } from "./pglite";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const MARKER = Buffer.from("PLAINTEXT_TRANSCRIPT_MARKER_7d2a");
const line = Buffer.concat([MARKER, Buffer.from(` ${"x".repeat(200)}\n`)]);
const first = Buffer.concat(
  Array.from({ length: Math.ceil(RUN_FILE_CHUNK_BYTES / line.length) }, () => line),
).subarray(0, RUN_FILE_CHUNK_BYTES);
const second = Buffer.concat([line, line]);
const whole = Buffer.concat([first, second]);

class Refused extends Error {}

describe("run file store", () => {
  let db: Db;
  let close: () => Promise<void>;
  let objects: ReturnType<typeof createFakeRunFileObjects>;
  let key: Buffer;
  beforeEach(async () => {
    ({ db, close } = await tempStore());
    // The store only touches the kind's row and chunk tables; the run and command rows it
    // references are another module's concern.
    await withoutForeignKeys(db);
    await db.run((q) =>
      q.exec(
        q.orm.insert(q.t.runnerTranscript).values(
          ["run-a", "run-b"].map((run) => ({
            runId: run,
            generation: 1,
            commandId: `command-${run}`,
            workspaceId: "workspace",
            executionId: "execution",
          })),
        ),
      ),
    );
    objects = createFakeRunFileObjects();
    key = randomBytes(32);
  });
  afterEach(() => close());

  const file = (runId: string) => ({ runId, generation: 1, prefix: `paws/test/${runId}` });
  const store = (storeKey = key, plaintext?: () => Promise<boolean>) =>
    createRunFileChunks({
      store: db,
      kind: "transcript",
      objects,
      key: storeKey,
      refused: () => {
        throw new Refused();
      },
      plaintext,
    });
  const state = (runId: string) =>
    function* (q: Q) {
      const { runnerTranscript } = q.t;
      const row = yield* q.one(
        q.orm
          .select({ size: runnerTranscript.sizeBytes })
          .from(runnerTranscript)
          .where(eq(runnerTranscript.runId, runId)),
      );
      return { ...file(runId), open: true, sizeBytes: row!.size };
    };
  const setKeyId = (keyId: string | null) =>
    db.run((q) =>
      q.exec(
        q.orm
          .update(q.t.runnerTranscriptChunk)
          .set({ keyId })
          .where(eq(q.t.runnerTranscriptChunk.runId, "run-a")),
      ),
    );
  async function upload(runId: string, chunks = store()) {
    for (const [offset, bytes] of [
      [0, first],
      [RUN_FILE_CHUNK_BYTES, second],
    ] as const)
      await chunks.upload(
        runId,
        { generation: 1, offset, sha256: sha(bytes), data: bytes.toString("base64") },
        16_777_216,
        state(runId),
      );
    return chunks;
  }
  async function collect(chunks: ReturnType<typeof store>, runId: string) {
    const parts: Uint8Array[] = [];
    for await (const part of chunks.read(file(runId), whole.length, sha(whole))) parts.push(part);
    return Buffer.concat(parts);
  }

  test("a transcript chunk written and read back round-trips", async () => {
    const chunks = await upload("run-a");
    await chunks.verify(file("run-a"), whole.length, sha(whole));
    expect(await collect(chunks, "run-a")).toEqual(whole);
    await expect(chunks.verify(file("run-a"), whole.length, sha(first))).rejects.toThrow(Refused);
  });

  test("the stored bytes are not the plaintext", async () => {
    await upload("run-a");
    expect(objects.objects.size).toBe(2);
    for (const bytes of objects.objects.values()) {
      expect(Buffer.from(bytes).includes(MARKER)).toBe(false);
      expect(bytes.length).toBeGreaterThan(28);
    }
  });

  test("a chunk moved to another run or offset fails to decrypt", async () => {
    const chunks = await upload("run-a");
    await upload("run-b", chunks);
    const at = (runId: string, offset: number, bytes: Buffer) =>
      `${file(runId).prefix}/${offset}-${sha(bytes)}`;
    const original = objects.objects.get(at("run-a", 0, first))!;

    // Another run's ciphertext of the same plaintext at the same offset.
    objects.objects.set(at("run-a", 0, first), objects.objects.get(at("run-b", 0, first))!);
    await expect(collect(chunks, "run-a")).rejects.toThrow(RunFileStorageError);

    // The same run's chunk from another offset.
    objects.objects.set(at("run-a", 0, first), objects.objects.get(at("run-a", 524_288, second))!);
    await expect(collect(chunks, "run-a")).rejects.toThrow(RunFileStorageError);

    objects.objects.set(at("run-a", 0, first), original);
    expect(await collect(chunks, "run-a")).toEqual(whole);
  });

  test("a chunk recorded under another key ID is refused before it is decrypted", async () => {
    await upload("run-a");
    const other = store(randomBytes(32));
    await expect(collect(other, "run-a")).rejects.toThrow(
      "Runner transcript storage is unavailable",
    );
    await setKeyId("0".repeat(64));
    await expect(collect(store(), "run-a")).rejects.toThrow(RunFileStorageError);
    expect(runFileKeyId("transcript", key)).not.toBe(runFileKeyId("agent_session", key));
  });

  test("a chunk stored before encryption reads only while the store allows it", async () => {
    await upload("run-a");
    for (const [offset, bytes] of [
      [0, first],
      [RUN_FILE_CHUNK_BYTES, second],
    ] as const)
      objects.objects.set(`${file("run-a").prefix}/${offset}-${sha(bytes)}`, bytes);
    await setKeyId(null);
    expect(
      await collect(
        store(key, async () => true),
        "run-a",
      ),
    ).toEqual(whole);
    await expect(collect(store(), "run-a")).rejects.toThrow(RunFileStorageError);
  });

  test("each kind's key is its own owner-only secret, created on first use", () => {
    const home = tempHome();
    try {
      const paths = Object.values(RUN_FILE_KINDS).map(({ keyFile }) => join(home, keyFile));
      const [transcript, session] = [
        loadRunFileKey("transcript", paths[0]!),
        loadRunFileKey("agent_session", paths[1]!),
      ];
      expect(transcript.equals(session)).toBe(false);
      expect(loadRunFileKey("transcript", paths[0]!)).toEqual(transcript);
      expect(statSync(paths[0]!).mode & 0o777).toBe(0o600);
      expect(readFileSync(paths[0]!, "utf8").includes(transcript.toString("base64"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
