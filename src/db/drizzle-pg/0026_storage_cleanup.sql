CREATE TABLE "storage_cleanup" (
	"id" text PRIMARY KEY NOT NULL,
	"machine" text NOT NULL,
	"actor" text NOT NULL,
	"started_at" bigint NOT NULL,
	"finished_at" bigint,
	"categories" jsonb NOT NULL,
	"deleted" jsonb NOT NULL,
	"skipped" jsonb NOT NULL,
	"freed_bytes" bigint NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "storage_cleanup_preview" (
	"id" text PRIMARY KEY NOT NULL,
	"machine" text NOT NULL,
	"categories" jsonb NOT NULL,
	"items" jsonb NOT NULL,
	"kept" jsonb NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "storage_cleanup_machine_started_at" ON "storage_cleanup" USING btree ("machine","started_at");