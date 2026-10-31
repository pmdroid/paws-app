import type { Migration } from "../migration";

/**
 * The digest of the checks marked `recheck: true` under each Closeout run's policy. Runs from
 * before the key existed had no such check, so they record `""`.
 */
export const migration: Migration = {
  id: "20261028T1541_closeout_recheck_digest",
  sql: `
ALTER TABLE closeout_progress ADD COLUMN recheck_digest TEXT;
UPDATE closeout_progress SET recheck_digest = '';
`,
};
