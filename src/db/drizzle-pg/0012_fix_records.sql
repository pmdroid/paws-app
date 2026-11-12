CREATE TABLE "fix_record" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"run_id" text,
	"linear_identifier" text NOT NULL,
	"repository" text,
	"reason" text NOT NULL,
	"triggers" jsonb NOT NULL,
	"round" bigint NOT NULL,
	"started_at" bigint NOT NULL,
	"ended_at" bigint,
	"outcome" text,
	"head_before" text,
	"head_after" text,
	"agent" text,
	"model" text,
	"duration_ms" bigint,
	CONSTRAINT "fix_record_check_1" CHECK (reason IN ('ci', 'review', 'conflict', 'findings', 'suggested', 'follow_up')),
	CONSTRAINT "fix_record_check_3" CHECK (outcome IN ('fixed', 'not_fixed', 'asked', 'abandoned'))
);
--> statement-breakpoint
CREATE INDEX "fix_record_item_open" ON "fix_record" USING btree ("item_id","ended_at");--> statement-breakpoint
CREATE INDEX "fix_record_started" ON "fix_record" USING btree ("started_at");