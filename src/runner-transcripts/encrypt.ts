import type { Database } from "bun:sqlite";
import { plaintextTranscriptChunks, sqliteDb } from "../db";
import { createRunFileChunks, type RunFileObjects } from "../run-files";
import { denied, transcriptPrefix } from "./store";

const BATCH = 100;

/**
 * The `runner-transcripts.encrypt` job: seals every transcript chunk without a key ID in each
 * store that may hold it (the local directory, then S3 when configured). Progress is the key ID
 * on each chunk row, so a restart resumes where it stopped while uploads and reads go on. A chunk
 * no store holds a readable copy of is counted as skipped and left; it was unreadable already.
 * The caller journals the counts.
 */
export async function encryptRunnerTranscripts(options: {
  db: Database;
  stores: readonly RunFileObjects[];
  /** The 32-byte key from `loadRunnerTranscriptKey`. */
  key: Buffer;
  signal?: AbortSignal;
}) {
  const { db, stores, signal } = options;
  if (!stores.length) throw new Error("Runner transcript storage is unavailable");
  const files = createRunFileChunks({
    store: sqliteDb(db),
    kind: "transcript",
    objects: stores[0]!,
    key: options.key,
    refused: denied,
  });
  let after: [string, number, number] = ["", 0, -1];
  let converted = 0;
  let skipped = 0;
  for (;;) {
    const rows = await plaintextTranscriptChunks(sqliteDb(db), after, BATCH);
    if (!rows.length) break;
    for (const row of rows) {
      signal?.throwIfAborted();
      const file = { runId: row.runId, generation: row.generation, prefix: transcriptPrefix(row) };
      const chunk = { offset: row.offset, sizeBytes: row.sizeBytes, sha256: row.sha256 };
      if (await files.encrypt(file, chunk, stores)) converted++;
      else skipped++;
      after = [row.runId, row.generation, row.offset];
    }
  }
  return { converted, skipped };
}
