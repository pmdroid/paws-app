CREATE TABLE "issue_split" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"workspace_id" text,
	"parent_issue_id" text NOT NULL,
	"parent_identifier" text NOT NULL,
	"repository" text,
	"drafts" jsonb NOT NULL,
	"question_id" text,
	"status" text NOT NULL,
	"decided_by" text,
	"created_at" bigint NOT NULL,
	"filed_at" bigint,
	"closed_at" bigint
);
--> statement-breakpoint
CREATE TABLE "issue_split_part" (
	"issue_id" text PRIMARY KEY NOT NULL,
	"split_id" text NOT NULL,
	"identifier" text NOT NULL,
	"url" text,
	"position" bigint NOT NULL,
	"merged_at" bigint
);
--> statement-breakpoint
ALTER TABLE "issue_split" ADD CONSTRAINT "issue_split_item_id_work_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."work_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_split_part" ADD CONSTRAINT "issue_split_part_split_id_issue_split_id_fk" FOREIGN KEY ("split_id") REFERENCES "public"."issue_split"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_split_workspace" ON "issue_split" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "issue_split_question" ON "issue_split" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "issue_split_part_split" ON "issue_split_part" USING btree ("split_id");