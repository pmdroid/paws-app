import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { immediate } from "../db";
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
type Chunk = { offset: number; sizeBytes: number; sha256: string; keyId: string | null };

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
  plaintext?: () => boolean;
}) {
  const { db, kind, objects, key, refused } = options;
  const { title, chunkTable } = RUN_FILE_KINDS[kind];
  if (key.length !== 32) throw new Error(`${title} key is invalid.`);
  const keyId = runFileKeyId(kind, key);

  function unavailable(): never {
    throw new RunFileStorageError(`${title} storage is unavailable`);
  }
  function objectKey(prefix: string, chunk: { offset: number; sha256: string }) {
    return `${prefix}/${chunk.offset}-${chunk.sha256}`;
  }
  function existing(runId: string, generation: number, offset: number) {
    return db
      .query<Chunk, [string, number, number]>(
        `SELECT offset,size_bytes AS sizeBytes,sha256,key_id AS keyId FROM ${chunkTable}
        WHERE run_id=? AND generation=? AND offset=?`,
      )
      .get(runId, generation, offset);
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
  async function* chunks(file: RunFile, before?: () => void) {
    const rows = db
      .query<Chunk, [string, number]>(
        `SELECT offset,size_bytes AS sizeBytes,sha256,key_id AS keyId FROM ${chunkTable}
        WHERE run_id=? AND generation=? ORDER BY offset`,
      )
      .all(file.runId, file.generation);
    let total = 0;
    let plaintext: boolean | undefined;
    for (const chunk of rows) {
      before?.();
      // A chunk without a key ID was stored before encryption and is read as is until it is
      // converted. It may be sealed between the row read and the object read, so it opens too.
      if (chunk.keyId === null) plaintext ??= options.plaintext?.() ?? false;
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
      state: () => RunFileState,
      /** True when the file was dropped while its chunk was written; the object is removed. */
      dropped?: () => boolean,
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
      const check = () => {
        const file = state();
        const previous = existing(runId, chunk.generation, chunk.offset);
        if (previous) {
          if (previous.sha256 !== chunk.sha256 || previous.sizeBytes !== bytes.length) refused();
        } else if (!file.open || file.sizeBytes !== chunk.offset) refused();
        return { file, previous };
      };
      const initial = immediate(db, check);
      if (initial.previous) return { offset: end, duplicate: true };
      const name = objectKey(initial.file.prefix, chunk);
      try {
        await objects.write(name, sealRunFileChunk(key, { runId, ...chunk }, bytes));
      } catch {
        unavailable();
      }
      try {
        return immediate(db, () => {
          const current = check();
          if (!current.previous) {
            db.run(
              `INSERT INTO ${chunkTable}(run_id,generation,offset,size_bytes,sha256,key_id)
              VALUES(?,?,?,?,?,?)`,
              [runId, chunk.generation, chunk.offset, bytes.length, chunk.sha256, keyId],
            );
            db.run(
              `UPDATE ${RUN_FILE_KINDS[kind].table} SET size_bytes=? WHERE run_id=? AND generation=?`,
              [end, runId, chunk.generation],
            );
          }
          return { offset: end, duplicate: !!current.previous };
        });
      } catch (error) {
        if (dropped?.())
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
      for (const store of stores) {
        let stored: Uint8Array;
        try {
          stored = await store.read(name);
        } catch (error) {
          if (missingRunFileObject(error)) continue;
          throw error;
        }
        if (matches(stored, row)) {
          await store.write(name, sealRunFileChunk(key, binding(file, row), stored));
          found = true;
        } else if (opened(file, row, stored)) found = true;
      }
      if (!found) return false;
      immediate(db, () =>
        db.run(
          `UPDATE ${chunkTable} SET key_id=?
          WHERE run_id=? AND generation=? AND offset=? AND sha256=? AND key_id IS NULL`,
          [keyId, file.runId, file.generation, chunk.offset, chunk.sha256],
        ),
      );
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
    async *read(file: RunFile, sizeBytes: number, sha256: string, before?: () => void) {
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
