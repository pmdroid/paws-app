import type { Migration } from "../migration";

/**
 * A running session moving off `runner_id`: asked from the runner card, waiting for an eligible
 * runner with the reason Linear got, or staying where it is with the reason it could not move.
 */
export const migration: Migration = {
  id: "20261027T0929_runner_session_move",
  sql: `
CREATE TABLE runner_session_move (
  run_id TEXT PRIMARY KEY REFERENCES run(id),
  runner_id TEXT NOT NULL REFERENCES runner(id),
  requested_by TEXT,
  status TEXT NOT NULL CHECK(status IN ('moving','waiting','stayed')),
  reason TEXT,
  updated_at INTEGER NOT NULL
) STRICT;
`,
};
