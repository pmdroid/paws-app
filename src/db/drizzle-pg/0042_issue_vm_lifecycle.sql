ALTER TABLE "issue_vm" DROP CONSTRAINT "issue_vm_state";--> statement-breakpoint
ALTER TABLE "issue_vm" ADD COLUMN "want" text DEFAULT 'awake' NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_vm" ADD COLUMN "deadline_at" bigint;--> statement-breakpoint
ALTER TABLE "issue_vm" ADD COLUMN "failure" text;--> statement-breakpoint
ALTER TABLE "issue_vm" ADD COLUMN "provider_ref" text;--> statement-breakpoint
ALTER TABLE "issue_vm" ADD COLUMN "generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_vm" ADD CONSTRAINT "issue_vm_want" CHECK (want IN ('awake','asleep'));--> statement-breakpoint
ALTER TABLE "issue_vm" ADD CONSTRAINT "issue_vm_state" CHECK (state IN ('creating','awake','sleeping','asleep','waking','unknown','deleting','deleted','failed'));