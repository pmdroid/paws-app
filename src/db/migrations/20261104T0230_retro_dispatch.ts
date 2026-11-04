import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261104T0230_retro_dispatch",
  sql: `
CREATE TABLE retro_dispatch (
  command_id TEXT PRIMARY KEY,
  retro_id TEXT NOT NULL REFERENCES retro(id),
  attempt INTEGER NOT NULL CHECK(attempt >= 1),
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  runner_id TEXT NOT NULL REFERENCES runner(id),
  runner_fence INTEGER NOT NULL,
  command TEXT NOT NULL CHECK(json_valid(command)),
  envelope TEXT NOT NULL CHECK(json_valid(envelope)),
  deliveries INTEGER NOT NULL DEFAULT 1 CHECK(deliveries >= 1),
  created_at INTEGER NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at > issued_at),
  fetched_at INTEGER,
  acknowledged_at INTEGER,
  cancel_requested_at INTEGER,
  result TEXT CHECK(result IS NULL OR json_valid(result)),
  result_at INTEGER,
  released_at INTEGER,
  release_reason TEXT CHECK(release_reason IS NULL OR release_reason IN
    ('result','not_started','teardown')),
  settled_at INTEGER,
  UNIQUE (retro_id, attempt),
  CHECK((released_at IS NULL) = (release_reason IS NULL)),
  CHECK(result IS NULL OR release_reason = 'result')
) STRICT;
CREATE INDEX retro_dispatch_runner_open ON retro_dispatch(runner_id) WHERE released_at IS NULL;
CREATE INDEX retro_dispatch_unsettled ON retro_dispatch(retro_id) WHERE settled_at IS NULL;
CREATE TRIGGER retro_dispatch_frozen BEFORE UPDATE ON retro_dispatch
WHEN OLD.retro_id IS NOT NEW.retro_id OR OLD.attempt IS NOT NEW.attempt
  OR OLD.runner_id IS NOT NEW.runner_id OR OLD.runner_fence IS NOT NEW.runner_fence
  OR OLD.command IS NOT NEW.command
  OR (OLD.result IS NOT NULL AND OLD.result IS NOT NEW.result)
  OR (OLD.released_at IS NOT NULL AND (OLD.released_at IS NOT NEW.released_at
    OR OLD.release_reason IS NOT NEW.release_reason))
BEGIN SELECT RAISE(ABORT, 'retro dispatch identity, result and release are immutable'); END;

CREATE TABLE retro_generation (
  retro_id TEXT PRIMARY KEY REFERENCES retro(id),
  diagnostic TEXT NOT NULL CHECK(diagnostic IN
    ('no_runner','capacity_wait','quota_cooldown','dispatched','active','unknown_outcome',
     'retry_backoff','failed','ready')),
  detail TEXT NOT NULL CHECK(length(detail) <= 2000),
  since INTEGER NOT NULL,
  until INTEGER,
  wait_ms INTEGER NOT NULL DEFAULT 0 CHECK(wait_ms >= 0),
  active_ms INTEGER NOT NULL DEFAULT 0 CHECK(active_ms >= 0),
  updated_at INTEGER NOT NULL
) STRICT;
`,
};
