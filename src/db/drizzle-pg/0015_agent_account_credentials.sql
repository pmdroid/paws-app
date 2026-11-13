CREATE TABLE "agent_account_credential" (
	"account_id" text PRIMARY KEY NOT NULL,
	"agent" text NOT NULL,
	"ciphertext" text NOT NULL,
	"version" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"runner_id" text
);
--> statement-breakpoint
CREATE TABLE "agent_account_lease" (
	"account_id" text PRIMARY KEY NOT NULL,
	"runner_id" text NOT NULL,
	"run_id" text NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_account_usage" (
	"account_id" text PRIMARY KEY NOT NULL,
	"runner_id" text NOT NULL,
	"limits_json" text NOT NULL,
	"observed_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_account" ADD COLUMN "position" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_account" ADD COLUMN "extra_usage" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_account_credential" ADD CONSTRAINT "agent_account_credential_account_id_agent_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."agent_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_account_credential" ADD CONSTRAINT "agent_account_credential_runner_id_runner_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_account_lease" ADD CONSTRAINT "agent_account_lease_account_id_agent_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."agent_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_account_lease" ADD CONSTRAINT "agent_account_lease_runner_id_runner_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_account_usage" ADD CONSTRAINT "agent_account_usage_account_id_agent_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."agent_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_account_usage" ADD CONSTRAINT "agent_account_usage_runner_id_runner_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runner"("id") ON DELETE no action ON UPDATE no action;