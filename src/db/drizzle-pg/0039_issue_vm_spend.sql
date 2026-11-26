CREATE TABLE "issue_vm_awake" (
	"id" text PRIMARY KEY NOT NULL,
	"issue_vm_id" text NOT NULL,
	"started_at" bigint NOT NULL,
	"ended_at" bigint,
	"hourly_usd" double precision
);
--> statement-breakpoint
CREATE TABLE "issue_vm_spend" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"monthly_limit_usd" double precision NOT NULL,
	"boat_hourly_usd" double precision,
	"instabox_hourly_usd" double precision,
	"updated_by" text,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_vm_awake" ADD CONSTRAINT "issue_vm_awake_issue_vm_id_issue_vm_id_fk" FOREIGN KEY ("issue_vm_id") REFERENCES "public"."issue_vm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_vm_spend" ADD CONSTRAINT "issue_vm_spend_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_vm_spend" ADD CONSTRAINT "issue_vm_spend_updated_by_workspace_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."workspace_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_vm_awake_open" ON "issue_vm_awake" USING btree ("issue_vm_id") WHERE ended_at IS NULL;--> statement-breakpoint
CREATE INDEX "issue_vm_awake_started" ON "issue_vm_awake" USING btree ("started_at");