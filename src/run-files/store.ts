import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  listRunFileChunksSteps,
  recordRunFileChunkSteps,
  runFileChunkSteps,
  setRunFileChunkKeySteps,
  sqliteDb,
  type Q,
  type RunFileChunkRow,
  type Steps,
} from "../db";
import { journalCaught } from "../journal";
import { openRunFileChunk, runFileKeyId, sealRunFileChunk } from "./key";
import { RUN_FILE_CHUNK_BYTES, RUN_FILE_KINDS, type RunFileKind } from "./kinds";
import { missingRunFileObject, type RunFileObjects } from "./objects";

export class RunFileStorageError extends Error {}

/** One run file: its rows are keyed by run and generation, its chunk objects live under `prefix`. */
export type RunFile = { runId: string; generation: number; prefix: string };
/** What the kind's row says about the file, checked in the same transaction as the chunk. */
export type RunFileState = RunFile & { sizeBytes: number; open: boolean };
export type RunFileChunk = { generation: number; offset: number; sha256: string; data: string };
type Chunk = RunFileChunkRow;

function hash(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Sealed, chunked run files of one kind. Every chunk is stored encrypted under the kind's key and
 * recorded with its size, plaintext sha256 and key ID. The kind owns its file row and who may
 * write or read it; `refused` is how it says no.
 */
export function createRunFileChunks(options: {
  db: Database;
  kind: RunFileKind;
  objects: RunFileObjects;
  /** The kind's 32-byte key from `loadRunFileKey`. */
  key: Buffer;
  refused: () => never;
  /** Whether a chunk stored before encryption (no key ID) still reads. Defaults to never. */
  plaintext?: () => Promise<boolean>;
}) {
  const { kind, objects, key, refused } = options;
  const store = sqliteDb(options.db);
  const { title } = RUN_FILE_KINDS[kind];
  if (key.length !== 32) throw new Error(`${title} key is invalid.`);
  const keyId = runFileKeyId(kind, key);

  function unavailable(): never {
    throw new RunFileStorageError(`${title} storage is unavailable`);
  }
  function objectKey(prefix: string, chunk: { offset: number; sha256: string }) {
    return `${prefix}/${chunk.offset}-${chunk.sha256}`;
  }

  function matches(bytes: Uint8Array, chunk: Chunk) {
    return bytes.length === chunk.sizeBytes && hash(bytes) === chunk.sha256;
  }
  function binding(file: RunFile, chunk: Chunk) {
    return { runId: file.runId, generation: file.generation, ...chunk };
  }
  /** The chunk's plaintext from a sealed object, or null when it does not open under this key. */
  function opened(file: RunFile, chunk: Chunk, stored: Uint8Array) {
    try {
      const bytes = openRunFileChunk(key, binding(file, chunk), stored);
      return matches(bytes, chunk) ? bytes : null;
    } catch {
      return null;
    }
  }

  /** Plaintext chunks in order, each checked against its recorded offset, size and sha256. */
  async function* chunks(file: RunFile, before?: () => Promise<void>) {
    const address = { kind, runId: file.runId, generation: file.generation };
    const rows = await store.run((q) => listRunFileChunksSteps(q, address));
    let total = 0;
    let plaintext: boolean | undefined;
    for (const chunk of rows) {
      await before?.();
      // A chunk without a key ID was stored before encryption and is read as is until it is
      // converted. It may be sealed between the row read and the object read, so it opens too.
      if (chunk.keyId === null) plaintext ??= (await options.plaintext?.()) ?? false;
      if (chunk.offset !== total || (!(chunk.keyId === null && plaintext) && chunk.keyId !== keyId))
        unavailable();
      let bytes: Buffer | null;
      try {
        const stored = await objects.read(objectKey(file.prefix, chunk));
        bytes =
          chunk.keyId === null && matches(stored, chunk)
            ? Buffer.from(stored)
            : opened(file, chunk, stored);
      } catch {
        unavailable();
      }
      if (!bytes) unavailable();
      total += bytes.length;
      yield bytes;
    }
  }

  return {
    objectKey,
    chunks,
    /**
     * Stores one chunk. `state` reads (or creates) the kind's row and refuses a writer it does not
     * accept; it runs before the object is written and again in the transaction that records it.
     * A retry with the same bytes at an accepted offset is a duplicate; changed bytes are refused.
     */
    async upload(
      runId: string,
      chunk: RunFileChunk,
      maxBytes: number,
      state: (q: Q) => Steps<RunFileState>,
      /** True when the file was dropped while its chunk was written; the object is removed. */
      dropped?: () => Promise<boolean>,
    ) {
      const bytes = Buffer.from(chunk.data, "base64");
      if (
        !bytes.length ||
        bytes.length > RUN_FILE_CHUNK_BYTES ||
        bytes.toString("base64") !== chunk.data ||
        hash(bytes) !== chunk.sha256 ||
        chunk.offset % RUN_FILE_CHUNK_BYTES !== 0 ||
        chunk.offset + bytes.length > maxBytes
      )
        refused();
      const end = chunk.offset + bytes.length;
      const address = { kind, runId, generation: chunk.generation };
      const check = function* (q: Q) {
        const file = yield* state(q);
        const previous = yield* runFileChunkSteps(q, address, chunk.offset);
        if (previous) {
          if (previous.sha256 !== chunk.sha256 || previous.sizeBytes !== bytes.length) refused();
        } else if (!file.open || file.sizeBytes !== chunk.offset) refused();
        return { file, previous };
      };
      const initial = await store.transaction(check);
      if (initial.previous) return { offset: end, duplicate: true };
      const name = objectKey(initial.file.prefix, chunk);
      try {
        await objects.write(name, sealRunFileChunk(key, { runId, ...chunk }, bytes));
      } catch {
        unavailable();
      }
      try {
        return await store.transaction(function* (q) {
          const current = yield* check(q);
          if (!current.previous) {
            yield* recordRunFileChunkSteps(
              q,
              address,
              { offset: chunk.offset, sizeBytes: bytes.length, sha256: chunk.sha256, keyId },
              end,
            );
          }
          return { offset: end, duplicate: !!current.previous };
        });
      } catch (error) {
        if (await dropped?.())
          await objects
            .delete(name)
            .catch((caught: unknown) => journalCaught(caught, "run-files.upload.delete", null));
        throw error;
      }
    },
    /**
     * Seals one chunk stored before encryption in every store that holds it, then records its key
     * ID. The sealed object replaces the plaintext one under the same name (a local store renames
     * a temp file over it), so no plaintext copy is left behind. A copy already sealed by an
     * interrupted conversion is kept. False when no store holds a readable copy.
     */
    async encrypt(file: RunFile, chunk: Omit<Chunk, "keyId">, stores: readonly RunFileObjects[]) {
      const row = { ...chunk, keyId: null };
      const name = objectKey(file.prefix, chunk);
      let found = false;
      for (const copy of stores) {
        let stored: Uint8Array;
        try {
          stored = await copy.read(name);
        } catch (error) {
          if (missingRunFileObject(error)) continue;
          throw error;
        }
        if (matches(stored, row)) {
          await copy.write(name, sealRunFileChunk(key, binding(file, row), stored));
          found = true;
        } else if (opened(file, row, stored)) found = true;
      }
      if (!found) return false;
      const address = { kind, runId: file.runId, generation: file.generation };
      await store.transaction((q) => setRunFileChunkKeySteps(q, address, chunk, keyId));
      return true;
    },
    /** Reads every chunk and refuses the seal unless they add up to `sizeBytes` and `sha256`. */
    async verify(file: RunFile, sizeBytes: number, sha256: string) {
      const digest = createHash("sha256");
      let total = 0;
      for await (const bytes of chunks(file)) {
        digest.update(bytes);
        total += bytes.length;
      }
      if (total !== sizeBytes || digest.digest("hex") !== sha256) refused();
    },
    /** The sealed file's plaintext, chunk by chunk; `before` re-checks access before each one. */
    async *read(file: RunFile, sizeBytes: number, sha256: string, before?: () => Promise<void>) {
      const digest = createHash("sha256");
      let total = 0;
      for await (const bytes of chunks(file, before)) {
        digest.update(bytes);
        total += bytes.length;
        yield bytes;
      }
      if (total !== sizeBytes || digest.digest("hex") !== sha256) unavailable();
    },
  };
}
export type RunFileChunks = ReturnType<typeof createRunFileChunks>;
