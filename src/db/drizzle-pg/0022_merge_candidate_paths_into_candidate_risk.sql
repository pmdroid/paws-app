ALTER TABLE "candidate_risk" ADD COLUMN "changed_paths" jsonb;--> statement-breakpoint
CREATE INDEX "candidate_risk_item" ON "candidate_risk" USING btree ("item_id","classified_at");