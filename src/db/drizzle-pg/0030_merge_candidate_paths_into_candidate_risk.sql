ALTER TABLE "candidate_risk" ALTER COLUMN "base_sha" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "candidate_risk" ALTER COLUMN "tier" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "candidate_risk" ALTER COLUMN "paths" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "candidate_risk" ALTER COLUMN "classified_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "candidate_risk" ADD COLUMN "changed_paths" jsonb;--> statement-breakpoint
ALTER TABLE "candidate_risk" ADD COLUMN "recorded_at" bigint;--> statement-breakpoint
CREATE INDEX "candidate_risk_item" ON "candidate_risk" USING btree ("item_id","recorded_at");