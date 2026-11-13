PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_member_vm` (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  vm_name TEXT NOT NULL UNIQUE,
  step TEXT NOT NULL CHECK(step IN ('create','install','enroll','health','ready')),
  failure TEXT,
  runner_id TEXT REFERENCES runner(id),
  step_started_at INTEGER NOT NULL,
  create_requested_at INTEGER,
  install_started_at INTEGER,
  token_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, install_at INTEGER, enroll_at INTEGER, health_at INTEGER, ready_at INTEGER, delete_step TEXT
  CHECK(delete_step IS NULL OR delete_step IN ('drain','tailnet','revoke','destroy','clear')), delete_runner_id TEXT, delete_requested_by TEXT, delete_force INTEGER NOT NULL DEFAULT 0 CHECK(delete_force IN (0,1)), delete_step_started_at INTEGER, delete_at TEXT CHECK(delete_at IS NULL OR json_valid(delete_at)), delete_failure TEXT, delete_blocked TEXT
  CHECK(delete_blocked IS NULL OR json_valid(delete_blocked)), enrollments_tracked INTEGER NOT NULL DEFAULT 1
  CHECK(enrollments_tracked IN (0,1)), pool TEXT,
  FOREIGN KEY(workspace_id,user_id) REFERENCES workspace_member(workspace_id,user_id)
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_member_vm` SELECT * FROM `member_vm`;--> statement-breakpoint
DROP TABLE `member_vm`;--> statement-breakpoint
ALTER TABLE `__new_member_vm` RENAME TO `member_vm`;--> statement-breakpoint
CREATE TRIGGER runner_setup_check_vm_ready AFTER UPDATE OF step ON member_vm
WHEN NEW.step='ready' AND OLD.step<>'ready' AND EXISTS(SELECT 1 FROM runner_setup_hold)
BEGIN
INSERT INTO job(queue,payload,run_at,max_attempts,created_at)
  SELECT 'runner_setup.check',json_object('ownerUserId',owners.id),0,3,
    CAST(strftime('%s','now') AS INTEGER)*1000
  FROM (SELECT DISTINCT h.owner_user_id AS id FROM runner_setup_hold h
    WHERE h.owner_user_id IS NOT NULL AND (h.owner_user_id=(SELECT r.owner_user_id FROM runner r WHERE r.id=NEW.runner_id) OR EXISTS(SELECT 1 FROM runner_policy p WHERE p.runner_id=NEW.runner_id AND p.sharing=1) OR h.owner_user_id=NEW.user_id)) owners
  WHERE NOT EXISTS(SELECT 1 FROM job j WHERE j.queue='runner_setup.check' AND j.status='pending'
    AND json_extract(j.payload,'$.ownerUserId')=owners.id);
END;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
