ALTER TABLE "runner_command" DROP CONSTRAINT "runner_command_check_1";--> statement-breakpoint
ALTER TABLE "storage_cleanup_preview" ADD COLUMN "pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "storage_cleanup_preview" ADD COLUMN "actor" text;--> statement-breakpoint
ALTER TABLE "runner_command" ADD CONSTRAINT "runner_command_check_1" CHECK (kind IN ('run','review','check','task','cancel','handover','checkpoint','probe','login_check','login','upgrade','storage.report','storage.cleanup'));