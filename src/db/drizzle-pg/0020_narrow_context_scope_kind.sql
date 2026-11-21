ALTER TABLE "context_forgotten_entry" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "context_forgotten_entry" CASCADE;--> statement-breakpoint
ALTER TABLE "context_scope" DROP CONSTRAINT "context_scope_kind";--> statement-breakpoint
ALTER TABLE "context_scope" DROP COLUMN "dreamed_at";--> statement-breakpoint
ALTER TABLE "context_scope" ADD CONSTRAINT "context_scope_kind" CHECK (scope_kind IN ('slack_channel','user_private'));