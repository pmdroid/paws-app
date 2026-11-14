ALTER TABLE "run" ADD COLUMN "owner_instance" text;--> statement-breakpoint
ALTER TABLE "runner_work" ADD COLUMN "skills" text;--> statement-breakpoint
ALTER TABLE "runner_work" ADD COLUMN "hooks" text;--> statement-breakpoint
ALTER TABLE "runner_work" ADD COLUMN "setup_recorded_at" bigint;--> statement-breakpoint
UPDATE "run" SET "owner_instance" = "run_owner"."owner_instance" FROM "run_owner" WHERE "run_owner"."run_id" = "run"."id";--> statement-breakpoint
UPDATE "runner_work" SET "skills" = "run_agent_setup"."skills", "hooks" = "run_agent_setup"."hooks", "setup_recorded_at" = "run_agent_setup"."recorded_at" FROM "run_agent_setup" WHERE "run_agent_setup"."run_id" = "runner_work"."run_id" AND "run_agent_setup"."runner_id" = "runner_work"."runner_id";--> statement-breakpoint
ALTER TABLE "run_agent_setup" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "run_owner" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "run_agent_setup" CASCADE;--> statement-breakpoint
DROP TABLE "run_owner" CASCADE;--> statement-breakpoint
CREATE INDEX "run_owner_instance" ON "run" USING btree ("owner_instance");
