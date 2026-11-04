import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261104T0540_retro_occurrence",
  sql: `
CREATE TABLE retro_occurrence (
  retro_id TEXT PRIMARY KEY REFERENCES retro(id),
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  origin TEXT NOT NULL CHECK(origin IN ('scheduled','manual')),
  occurrence_at INTEGER NOT NULL,
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL CHECK(window_end > window_start),
  time_zone TEXT NOT NULL,
  local_date TEXT NOT NULL,
  local_time TEXT NOT NULL,
  utc_offset_minutes INTEGER NOT NULL,
  local_adjustment TEXT NOT NULL CHECK(local_adjustment IN ('exact','skipped_forward','repeated_first')),
  settings_revision INTEGER NOT NULL,
  requested_by TEXT,
  created_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX retro_occurrence_scheduled ON retro_occurrence(workspace_id, occurrence_at)
  WHERE origin = 'scheduled';
CREATE TRIGGER retro_occurrence_immutable BEFORE UPDATE ON retro_occurrence
BEGIN SELECT RAISE(ABORT, 'retro occurrences are immutable'); END;

ALTER TABLE retro_schedule_runtime ADD COLUMN blocked_reason TEXT;
ALTER TABLE retro_schedule_runtime ADD COLUMN blocked_since INTEGER;
`,
};
