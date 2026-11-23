ALTER TABLE "runner_policy" DROP CONSTRAINT "runner_policy_check_2";--> statement-breakpoint
ALTER TABLE "runner" ADD COLUMN "isolation" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "runner_policy" DROP COLUMN "sharing";--> statement-breakpoint
ALTER TABLE "runner" ADD CONSTRAINT "runner_check_3" CHECK (isolation IN ('none','issue_vm'));