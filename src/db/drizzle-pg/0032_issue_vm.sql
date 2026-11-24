CREATE TABLE "issue_vm" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"item_id" text NOT NULL,
	"member_user_id" text NOT NULL,
	"provider" text NOT NULL,
	"host_runner_id" text,
	"runner_id" text,
	"state" text NOT NULL,
	"created_at" bigint NOT NULL,
	"state_at" bigint NOT NULL,
	"deleted_at" bigint,
	CONSTRAINT "issue_vm_provider" CHECK (provider IN ('exe-dev','boat','instabox','host')),
	CONSTRAINT "issue_vm_state" CHECK (state IN ('creating','awake','asleep','deleting','deleted','failed'))
);
--> statement-breakpoint
CREATE TABLE "issue_vm_grant" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"member_user_id" text NOT NULL,
	"limit" integer NOT NULL,
	"ends_at" bigint NOT NULL,
	"granted_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"revoked_at" bigint,
	CONSTRAINT "issue_vm_grant_limit" CHECK ("limit" BETWEEN 1 AND 50)
);
--> statement-breakpoint
ALTER TABLE "issue_vm" ADD CONSTRAINT "issue_vm_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_vm" ADD CONSTRAINT "issue_vm_item_id_work_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."work_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_vm" ADD CONSTRAINT "issue_vm_member_user_id_workspace_user_id_fk" FOREIGN KEY ("member_user_id") REFERENCES "public"."workspace_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_vm" ADD CONSTRAINT "issue_vm_host_runner_id_runner_id_fk" FOREIGN KEY ("host_runner_id") REFERENCES "public"."runner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_vm" ADD CONSTRAINT "issue_vm_runner_id_runner_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_vm_grant" ADD CONSTRAINT "issue_vm_grant_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_vm_grant" ADD CONSTRAINT "issue_vm_grant_member_user_id_workspace_user_id_fk" FOREIGN KEY ("member_user_id") REFERENCES "public"."workspace_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_vm_grant" ADD CONSTRAINT "issue_vm_grant_granted_by_workspace_user_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."workspace_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_vm_item_live" ON "issue_vm" USING btree ("item_id") WHERE state NOT IN ('deleted','failed');--> statement-breakpoint
CREATE INDEX "issue_vm_workspace_member" ON "issue_vm" USING btree ("workspace_id","member_user_id");--> statement-breakpoint
CREATE INDEX "issue_vm_grant_workspace_member" ON "issue_vm_grant" USING btree ("workspace_id","member_user_id");