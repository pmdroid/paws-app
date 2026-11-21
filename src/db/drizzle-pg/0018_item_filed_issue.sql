CREATE TABLE "item_filed_issue" (
	"item_id" text NOT NULL,
	"linear_issue_id" text NOT NULL,
	"identifier" text NOT NULL,
	"title" text NOT NULL,
	"url" text,
	"started" boolean NOT NULL,
	"run_id" text NOT NULL,
	"filed_at" bigint NOT NULL,
	CONSTRAINT "item_filed_issue_item_id_linear_issue_id_pk" PRIMARY KEY("item_id","linear_issue_id")
);
--> statement-breakpoint
ALTER TABLE "item_filed_issue" ADD CONSTRAINT "item_filed_issue_item_id_work_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."work_item"("id") ON DELETE no action ON UPDATE no action;