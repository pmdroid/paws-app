CREATE TABLE "runner_test_permit" (
	"run_id" text PRIMARY KEY NOT NULL,
	"runner_id" text NOT NULL,
	"requested_at" bigint NOT NULL,
	"granted_at" bigint,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "runner_test_permit_queue" ON "runner_test_permit" USING btree ("runner_id","requested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "runner_test_permit_holder" ON "runner_test_permit" USING btree ("runner_id") WHERE granted_at IS NOT NULL;