import type { Migration } from "../migration";

/**
 * Removes what the 2026-10-25 audit found unused: the GitHub issue poller tables of `005`, the
 * runner verifier of `034` and the runner check tables of `036`, which no code reads or writes.
 * Activity rows still written as `linear.activity` become `activity`, and `linear.epic.reconcile`
 * jobs, which nothing enqueues or handles any more, are cancelled.
 */
export const migration: Migration = {
  id: "20261027T2209_dead_code_cleanup",
  sql: `
DROP TABLE IF EXISTS github_poll_state;
DROP TABLE IF EXISTS github_seen;
DROP TABLE IF EXISTS github_label_state;
DROP TABLE IF EXISTS runner_verifier;
DROP TABLE IF EXISTS runner_check_execution;
DROP TABLE IF EXISTS runner_check_attempt;
UPDATE outbox SET op = 'activity' WHERE op = 'linear.activity';
UPDATE job SET status = 'cancelled' WHERE queue = 'linear.epic.reconcile' AND status IN ('pending', 'running');
`,
};
