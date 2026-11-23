ALTER TABLE "member_vm" ADD COLUMN "provider" text DEFAULT 'exe-dev' NOT NULL;--> statement-breakpoint
ALTER TABLE "member_vm" ADD COLUMN "provider_vm_id" text;--> statement-breakpoint
ALTER TABLE "member_vm" ADD CONSTRAINT "member_vm_check_7" CHECK (provider IN ('exe-dev','boat','instabox'));