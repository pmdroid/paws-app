ALTER TABLE "runner" DROP COLUMN "metrics_url";--> statement-breakpoint
ALTER TABLE "runner" DROP COLUMN "metrics_reported_at";--> statement-breakpoint
DELETE FROM "secret" WHERE "name" = 'prometheus-sd-token';