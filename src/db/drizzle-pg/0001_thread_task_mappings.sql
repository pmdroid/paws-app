CREATE TABLE "thread_context" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"surface" text NOT NULL,
	"installation_id" text NOT NULL,
	"kind" text NOT NULL,
	"channel_id" text NOT NULL,
	"thread_id" text DEFAULT '' NOT NULL,
	"private_member" text DEFAULT '' NOT NULL,
	"task_id" text NOT NULL,
	"actor" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "thread_context_key" UNIQUE("workspace_id","surface","installation_id","channel_id","thread_id","private_member"),
	CONSTRAINT "thread_context_surface" CHECK (surface IN ('slack', 'buzz')),
	CONSTRAINT "thread_context_kind" CHECK (kind IN ('thread', 'private', 'code_channel', 'project_hub')),
	CONSTRAINT "thread_context_private" CHECK ((kind = 'private') = (private_member <> ''))
);
--> statement-breakpoint
CREATE TABLE "thread_task" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"surface" text NOT NULL,
	"installation_id" text NOT NULL,
	"private_member" text DEFAULT '' NOT NULL,
	"primary_context_id" text NOT NULL,
	"created_by" text NOT NULL,
	"created_by_user_id" text,
	"repository" text,
	"source_ref" text,
	"source_commit" text,
	"source_set_by" text,
	"linear_issue_id" text,
	"issue_attached_at" bigint,
	"delegation_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "thread_task_surface" CHECK (surface IN ('slack', 'buzz'))
);
--> statement-breakpoint
ALTER TABLE "outbox" DROP CONSTRAINT "outbox_check_1";--> statement-breakpoint
ALTER TABLE "thread_context" ADD CONSTRAINT "thread_context_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_context" ADD CONSTRAINT "thread_context_task_id_thread_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."thread_task"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_task" ADD CONSTRAINT "thread_task_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_task" ADD CONSTRAINT "thread_task_created_by_user_id_workspace_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."workspace_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "thread_context_task" ON "thread_context" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "thread_task_issue" ON "thread_task" USING btree ("workspace_id","linear_issue_id") WHERE linear_issue_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_check_1" CHECK (target IN ('linear', 'slack', 'buzz', 'github', 'sandbox'));