DROP INDEX "context_summary_partition";--> statement-breakpoint
ALTER TABLE "context_scope" ADD COLUMN "dreamed_at" bigint;--> statement-breakpoint
ALTER TABLE "context_summary" ADD COLUMN "title" text;--> statement-breakpoint
CREATE UNIQUE INDEX "context_summary_partition" ON "context_summary" USING btree ("workspace_id","scope_kind","scope_id","partition") WHERE title IS NULL;