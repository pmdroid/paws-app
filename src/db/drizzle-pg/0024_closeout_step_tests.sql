ALTER TABLE "closeout_step" ADD COLUMN "failed_tests" jsonb;--> statement-breakpoint
ALTER TABLE "closeout_step" ADD COLUMN "test_selection" jsonb;