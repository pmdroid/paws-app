ALTER TABLE "workspace" ADD COLUMN "finding_grouping_off" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "workspace" SET "finding_grouping_off" = 1 WHERE "id" IN (SELECT "workspace_id" FROM "finding_grouping_off");--> statement-breakpoint
INSERT INTO "setting" ("key", "value", "updated_at") SELECT 'agent_catalog_refreshed_at', "completed_at"::text, "completed_at" FROM "agent_catalog_refresh" WHERE "id" = 1 ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "setting" ("key", "value", "updated_at") SELECT 'linear_outbox_not_before', "not_before"::text, (extract(epoch FROM now()) * 1000)::bigint FROM "linear_outbox_backoff" WHERE "id" = 1 ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
DROP TABLE "agent_catalog_refresh" CASCADE;--> statement-breakpoint
DROP TABLE "finding_grouping_off" CASCADE;--> statement-breakpoint
DROP TABLE "linear_outbox_backoff" CASCADE;
