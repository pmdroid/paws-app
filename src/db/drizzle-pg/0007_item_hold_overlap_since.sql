ALTER TABLE "item_hold" ALTER COLUMN "reason" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "item_hold" ADD COLUMN "overlap_since" bigint;