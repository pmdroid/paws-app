import type { Migration } from "../migration";

/** Paws may ask a runner to checkpoint a running session before it stops it (`checkpoint` runner command). */
export const migration: Migration = {
  id: "20261027T0500_runner_command_checkpoint",
  foreignKeys: false,
  sql: `
CREATE TABLE runner_command_with_checkpoint (
  ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  runner_id TEXT NOT NULL REFERENCES runner(id),
  run_id TEXT REFERENCES run(id),
  generation INTEGER,
  kind TEXT NOT NULL CHECK(kind IN ('run','review','check','task','cancel','handover','checkpoint','probe','login_check','login','upgrade')),
  envelope TEXT NOT NULL CHECK(json_valid(envelope)),
  expires_at INTEGER NOT NULL,
  acknowledged_at INTEGER
) STRICT;
INSERT INTO runner_command_with_checkpoint SELECT * FROM runner_command;
INSERT INTO sqlite_sequence(name,seq)
SELECT 'runner_command_with_checkpoint',seq FROM sqlite_sequence WHERE name='runner_command'
AND NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='runner_command_with_checkpoint');
UPDATE sqlite_sequence SET seq=MAX(seq,COALESCE((SELECT seq FROM sqlite_sequence WHERE name='runner_command'),0))
WHERE name='runner_command_with_checkpoint';
DROP TABLE runner_command;
ALTER TABLE runner_command_with_checkpoint RENAME TO runner_command;
CREATE INDEX runner_command_pending ON runner_command(runner_id,acknowledged_at,ordinal);
`,
};
