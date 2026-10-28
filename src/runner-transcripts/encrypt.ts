import type { Database } from "bun:sqlite";
import { journal } from "../journal";
import { createRunFileChunks, type RunFileObjects } from "../run-files";
import { denied, transcriptPrefix } from "./store";

type Plaintext = {
  runId: string;
  generation: number;
  offset: number;
  sizeBytes: number;
  sha256: string;
  workspaceId: string;
  commandId: string;
  executionId: string;
};

const BATCH = 100;

/**
 * The `runner-transcripts.encrypt` job: seals every transcript chunk without a key ID in each
 * store that may hold it (the local directory, then S3 when configured). Progress is the key ID
 * on each chunk row, so a restart resumes where it stopped while uploads and reads go on. A chunk
 * no store holds a readable copy of is journaled and left; it was unreadable already.
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
    db,
    kind: "transcript",
    objects: stores[0]!,
    key: options.key,
    refused: denied,
  });
  const next = db.query<Plaintext, [string, number, number]>(
    `SELECT c.run_id AS runId,c.generation,c.offset,c.size_bytes AS sizeBytes,c.sha256,
    t.workspace_id AS workspaceId,t.command_id AS commandId,t.execution_id AS executionId
    FROM runner_transcript_chunk c JOIN runner_transcript t USING(run_id,generation)
    WHERE c.key_id IS NULL AND (c.run_id,c.generation,c.offset)>(?,?,?)
    ORDER BY c.run_id,c.generation,c.offset LIMIT ${BATCH}`,
  );
  let after: [string, number, number] = ["", 0, -1];
  let converted = 0;
  let skipped = 0;
  for (;;) {
    const rows = next.all(...after);
    if (!rows.length) break;
    for (const row of rows) {
      signal?.throwIfAborted();
      const file = { runId: row.runId, generation: row.generation, prefix: transcriptPrefix(row) };
      const chunk = { offset: row.offset, sizeBytes: row.sizeBytes, sha256: row.sha256 };
      if (await files.encrypt(file, chunk, stores)) converted++;
      else {
        skipped++;
        journal(
          `runner transcript chunk ${row.runId}/${row.generation}/${row.offset} has no readable copy`,
        );
      }
      after = [row.runId, row.generation, row.offset];
    }
  }
  journal(`runner transcripts encrypted: ${converted} chunks sealed, ${skipped} unreadable`);
  return { converted, skipped };
}
