-- The Postgres counterpart of the SQLite runner_setup_hold_ends and runner_setup_resume_ends
-- triggers. A runner setup hold ends when its item leaves `queued` or a Stop is requested, and a
-- Stop drops a pending resume. Every write that changes an item's state or asks it to stop is
-- covered, whichever module makes it. The runner_setup_check_* triggers have no counterpart here:
-- the writes they watch queue the check themselves (enqueueRunnerSetupChecksSteps).
CREATE FUNCTION runner_setup_hold_end() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM runner_setup_hold WHERE item_id = NEW.id;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION runner_setup_resume_end() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM runner_setup_resume WHERE item_id = NEW.id;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER runner_setup_hold_ends AFTER UPDATE OF state, cancel_requested ON work_item
FOR EACH ROW WHEN (NEW.state <> 'queued' OR NEW.cancel_requested = 1)
EXECUTE FUNCTION runner_setup_hold_end();
--> statement-breakpoint
CREATE TRIGGER runner_setup_resume_ends AFTER UPDATE OF cancel_requested ON work_item
FOR EACH ROW WHEN (NEW.cancel_requested = 1)
EXECUTE FUNCTION runner_setup_resume_end();
