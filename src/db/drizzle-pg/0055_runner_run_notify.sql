CREATE FUNCTION runner_run_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('paws_runner_run', NEW.run_id);
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER runner_event_notifies AFTER INSERT ON runner_event
FOR EACH ROW EXECUTE FUNCTION runner_run_notify();
--> statement-breakpoint
CREATE TRIGGER runner_result_notifies AFTER INSERT ON runner_result
FOR EACH ROW EXECUTE FUNCTION runner_run_notify();
