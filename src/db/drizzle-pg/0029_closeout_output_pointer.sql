ALTER TABLE "agent_closeout_event" ADD COLUMN "output_key" text;--> statement-breakpoint
ALTER TABLE "agent_closeout_event" ADD COLUMN "output_bytes" bigint;--> statement-breakpoint
ALTER TABLE "agent_closeout_event" ADD COLUMN "output_sha256" text;--> statement-breakpoint
ALTER TABLE "closeout_step" ADD COLUMN "output_key" text;--> statement-breakpoint
ALTER TABLE "closeout_step" ADD COLUMN "output_bytes" bigint;--> statement-breakpoint
ALTER TABLE "closeout_step" ADD COLUMN "output_sha256" text;