ALTER TABLE "runner_enrollment" ADD COLUMN "kind" text DEFAULT 'personal' NOT NULL;--> statement-breakpoint
ALTER TABLE "runner_enrollment" ADD COLUMN "vm_host_settings" jsonb;--> statement-breakpoint
ALTER TABLE "runner_enrollment" ADD CONSTRAINT "runner_enrollment_kind" CHECK (kind IN ('personal','vm_host'));