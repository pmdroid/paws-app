ALTER TABLE "item_pull_request" ADD COLUMN "published_head" text;--> statement-breakpoint
ALTER TABLE "item_pull_request" ADD COLUMN "open_findings_line" text;--> statement-breakpoint
ALTER TABLE "linear_session" ADD COLUMN "activities_listed_generation" bigint;