ALTER TABLE "runner" ADD COLUMN "issue_vm_id" text;--> statement-breakpoint
ALTER TABLE "runner_enrollment" ADD COLUMN "issue_vm_id" text;--> statement-breakpoint
ALTER TABLE "runner_enrollment" ADD CONSTRAINT "runner_enrollment_issue_vm_id_issue_vm_id_fk" FOREIGN KEY ("issue_vm_id") REFERENCES "public"."issue_vm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "runner_issue_vm" ON "runner" USING btree ("issue_vm_id");--> statement-breakpoint
ALTER TABLE "runner" ADD CONSTRAINT "runner_check_4" CHECK (issue_vm_id IS NULL OR isolation = 'issue_vm');