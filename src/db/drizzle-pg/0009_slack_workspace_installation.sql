CREATE TABLE "workspace_slack_installation" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"generation" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'none' NOT NULL,
	"team_id" text,
	"team_name" text,
	"app_id" text,
	"bot_user_id" text,
	"scope" text DEFAULT '' NOT NULL,
	"source" text,
	"actor_id" text,
	"updated_at" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "workspace_slack_installation_status" CHECK (status IN ('none','active','disconnected','revoked')),
	CONSTRAINT "workspace_slack_installation_source" CHECK (source IS NULL OR source IN ('oauth','cli'))
);
--> statement-breakpoint
CREATE TABLE "workspace_slack_oauth" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"session_hash" text NOT NULL,
	"intent" text NOT NULL,
	"expected_generation" bigint NOT NULL,
	"return_team_id" text,
	"return_channel_id" text,
	"expires_at" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	CONSTRAINT "workspace_slack_oauth_intent" CHECK (intent IN ('install','reconnect','replace')),
	CONSTRAINT "workspace_slack_oauth_status" CHECK (status IN ('pending','claimed','complete','failed'))
);
--> statement-breakpoint
ALTER TABLE "workspace_slack_installation" ADD CONSTRAINT "workspace_slack_installation_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_slack_installation" ADD CONSTRAINT "workspace_slack_installation_actor_id_workspace_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."workspace_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_slack_oauth" ADD CONSTRAINT "workspace_slack_oauth_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_slack_oauth" ADD CONSTRAINT "workspace_slack_oauth_user_id_workspace_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."workspace_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_slack_installation_active_team" ON "workspace_slack_installation" USING btree ("team_id") WHERE status = 'active';