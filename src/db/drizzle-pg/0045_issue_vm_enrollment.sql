ALTER TABLE "runner_enrollment" ADD COLUMN "issue_vm_id" text;--> statement-breakpoint
ALTER TABLE "issue_vm" ADD COLUMN "token_minted_at" bigint;