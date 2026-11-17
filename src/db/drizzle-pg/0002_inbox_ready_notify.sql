CREATE FUNCTION inbox_ready_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('paws_inbox_ready', '');
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER inbox_ready_notifies AFTER INSERT ON inbox_event
FOR EACH ROW EXECUTE FUNCTION inbox_ready_notify();
