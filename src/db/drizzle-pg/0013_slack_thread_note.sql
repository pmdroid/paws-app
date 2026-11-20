CREATE TABLE "slack_thread_note" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"request_id" text NOT NULL,
	"author_user_id" text NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"repository" text,
	"path" text,
	"symbol" text,
	"commit" text,
	"sources" jsonb NOT NULL,
	"linear_team_ids" jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "slack_thread_note_kind" CHECK (kind IN ('observation', 'guess', 'decision'))
);
--> statement-breakpoint
ALTER TABLE "slack_thread_note" ADD CONSTRAINT "slack_thread_note_conversation_id_slack_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."slack_conversation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "slack_thread_note_conversation" ON "slack_thread_note" USING btree ("conversation_id","created_at");