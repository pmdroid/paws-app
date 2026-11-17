CREATE FUNCTION job_ready_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('paws_job_ready', NEW.queue);
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER job_ready_notifies AFTER INSERT OR UPDATE OF run_at, status ON job
FOR EACH ROW WHEN (
  NEW.status = 'pending'
  AND NEW.run_at <= floor(extract(epoch FROM clock_timestamp()) * 1000) + 1000
)
EXECUTE FUNCTION job_ready_notify();
