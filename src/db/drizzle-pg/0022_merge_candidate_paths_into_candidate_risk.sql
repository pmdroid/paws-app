ALTER TABLE "candidate_risk" ADD COLUMN "changed_paths" jsonb;--> statement-breakpoint
UPDATE "candidate_risk" SET "changed_paths" = "candidate_paths"."paths" FROM "candidate_paths" WHERE "candidate_paths"."item_id" = "candidate_risk"."item_id" AND "candidate_paths"."head_sha" = "candidate_risk"."head_sha";--> statement-breakpoint
DROP TABLE "candidate_paths" CASCADE;--> statement-breakpoint
CREATE INDEX "candidate_risk_item" ON "candidate_risk" USING btree ("item_id","classified_at");
