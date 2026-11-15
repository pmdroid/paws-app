ALTER TABLE "agent_account_health" ALTER COLUMN "binding_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_account_health" ALTER COLUMN "runner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_account_health" ADD COLUMN "limits_json" text;