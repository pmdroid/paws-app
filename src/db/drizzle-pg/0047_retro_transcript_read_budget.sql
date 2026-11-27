ALTER TABLE "retro_attempt" ADD COLUMN "transcript_reads" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "retro_attempt" ADD COLUMN "transcript_bytes" bigint DEFAULT 0 NOT NULL;