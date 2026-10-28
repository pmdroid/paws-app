import type { Migration } from "../migration";

/** Transcript chunks record the key that sealed them; a chunk stored before encryption has none. */
export const migration: Migration = {
  id: "20261028T0052_runner_transcript_chunk_key",
  sql: `ALTER TABLE runner_transcript_chunk ADD COLUMN key_id TEXT
CHECK(key_id IS NULL OR length(key_id)=64);`,
};
