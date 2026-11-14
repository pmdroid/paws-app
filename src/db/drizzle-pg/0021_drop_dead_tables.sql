CREATE SEQUENCE "job_activation_seq" AS bigint;--> statement-breakpoint
ALTER TABLE "job" ALTER COLUMN "activation_id" SET DEFAULT nextval('job_activation_seq');--> statement-breakpoint
SELECT setval('job_activation_seq', GREATEST(COALESCE((SELECT MAX("activation_id") FROM "job"), 0), COALESCE((SELECT MAX("id") FROM "job_activation"), 0), COALESCE(pg_sequence_last_value(pg_get_serial_sequence('job_activation', 'id')::regclass), 0)) + 1, false);--> statement-breakpoint
DROP TABLE "linear_input" CASCADE;--> statement-breakpoint
DROP TABLE "linear_item_caller_request" CASCADE;--> statement-breakpoint
DROP TABLE "run_review_rounds" CASCADE;--> statement-breakpoint
DROP TABLE "job_activation" CASCADE;--> statement-breakpoint
DROP TABLE "paws_alive" CASCADE;
