CREATE TABLE "merge_wait_mark" (
	"item_id" text NOT NULL,
	"head" text NOT NULL,
	"kind" text NOT NULL,
	"at" bigint NOT NULL,
	CONSTRAINT "merge_wait_mark_item_id_head_kind_pk" PRIMARY KEY("item_id","head","kind"),
	CONSTRAINT "merge_wait_mark_kind" CHECK (kind IN ('review_started','review_ended','enqueued'))
);
--> statement-breakpoint
ALTER TABLE "merge_wait_mark" ADD CONSTRAINT "merge_wait_mark_item_id_work_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."work_item"("id") ON DELETE no action ON UPDATE no action;