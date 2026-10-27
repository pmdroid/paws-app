import type { Migration } from "../migration";

/**
 * A review step's `failOn` and the indexes of the findings in its evidence record that are in
 * pre-existing code (a JSON array), so the issue page can mark the finding that blocked.
 */
export const migration: Migration = {
  id: "20261027T0451_closeout_step_review_marks",
  sql: `ALTER TABLE closeout_step ADD COLUMN review_fail_on TEXT CHECK (review_fail_on IS NULL OR review_fail_on IN ('P0', 'P1', 'P2', 'P3'));
ALTER TABLE closeout_step ADD COLUMN review_pre_existing TEXT;`,
};
