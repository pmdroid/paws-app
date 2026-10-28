import type { Migration } from "../migration";

/**
 * Enqueues the one-time job that seals transcript chunks stored before encryption, when there are
 * any. Until it is done, a chunk without a key ID still reads; afterwards it is refused. A
 * database without such chunks gets no job, since every chunk written from now on has a key ID.
 */
export const migration: Migration = {
  id: "20261028T0150_runner_transcript_encrypt_job",
  sql: `INSERT OR IGNORE INTO job(queue,job_key,priority,run_at,max_attempts,created_at)
SELECT 'runner-transcripts.encrypt','runner-transcripts.encrypt',9,
  CAST(strftime('%s','now') AS INTEGER)*1000,1000,CAST(strftime('%s','now') AS INTEGER)*1000
WHERE EXISTS(SELECT 1 FROM runner_transcript_chunk WHERE key_id IS NULL);`,
};
