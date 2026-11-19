CREATE TABLE "slack_conversation" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"team_id" text NOT NULL,
	"app_id" text,
	"install_generation" bigint NOT NULL,
	"channel_id" text NOT NULL,
	"thread_ts" text NOT NULL,
	"started_by_slack_user_id" text NOT NULL,
	"started_event_id" text NOT NULL,
	"reply_channel_id" text NOT NULL,
	"reply_thread_ts" text NOT NULL,
	"work_item_id" text,
	"issue_id" text,
	"stopped_ts" text,
	"stopped_by_slack_user_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "slack_conversation_thread" UNIQUE("workspace_id","team_id","channel_id","thread_ts","install_generation")
);
--> statement-breakpoint
ALTER TABLE "slack_conversation" ADD CONSTRAINT "slack_conversation_work_item_id_work_item_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_item"("id") ON DELETE no action ON UPDATE no action;