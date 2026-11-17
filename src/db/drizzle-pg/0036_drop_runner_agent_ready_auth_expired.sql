ALTER TABLE "runner_agent_policy" DROP CONSTRAINT "runner_agent_policy_check_2";--> statement-breakpoint
ALTER TABLE "runner_agent_policy" DROP CONSTRAINT "runner_agent_policy_check_3";--> statement-breakpoint
ALTER TABLE "runner_agent_policy" DROP COLUMN "ready";--> statement-breakpoint
ALTER TABLE "runner_agent_policy" DROP COLUMN "auth_expired";