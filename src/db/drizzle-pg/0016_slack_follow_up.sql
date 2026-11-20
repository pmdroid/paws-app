CREATE TABLE "slack_follow_up" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"team_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"thread_ts" text NOT NULL,
	"generation" bigint NOT NULL,
	"slack_user_id" text NOT NULL,
	"user_id" text NOT NULL,
	"link_id" text NOT NULL,
	"mention_ts" text NOT NULL,
	"purpose" text NOT NULL,
	"trigger" jsonb NOT NULL,
	"status" text NOT NULL,
	"created_at" bigint NOT NULL,
	"due_at" bigint,
	"expires_at" bigint NOT NULL,
	"claimed_at" bigint,
	"finished_at" bigint,
	CONSTRAINT "slack_follow_up_status" CHECK (status IN ('pending', 'claimed', 'done', 'cancelled', 'expired')),
	CONSTRAINT "slack_follow_up_purpose" CHECK (char_length(purpose) BETWEEN 1 AND 500)
);
--> statement-breakpoint
CREATE INDEX "slack_follow_up_thread" ON "slack_follow_up" USING btree ("workspace_id","team_id","channel_id","thread_ts","generation");--> statement-breakpoint
CREATE INDEX "slack_follow_up_user" ON "slack_follow_up" USING btree ("user_id","status");