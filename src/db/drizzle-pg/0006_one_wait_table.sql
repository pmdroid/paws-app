ALTER TABLE "item_wait" RENAME TO "__old_item_wait";--> statement-breakpoint
CREATE TABLE "item_wait" (
	"item_id" text NOT NULL,
	"kind" text NOT NULL,
	"version" bigint NOT NULL,
	"since" bigint NOT NULL,
	CONSTRAINT "item_wait_item_id_kind_pk" PRIMARY KEY("item_id","kind"),
	CONSTRAINT "item_wait_check_1" CHECK (kind IN ('queue','item'))
);
--> statement-breakpoint
INSERT INTO "item_wait" ("item_id", "kind", "version", "since") SELECT "item_id", 'item', "version", "since" FROM "__old_item_wait";--> statement-breakpoint
INSERT INTO "item_wait" ("item_id", "kind", "version", "since") SELECT DISTINCT ON ("item_id") "item_id", 'queue', "version", "since" FROM "queue_wait" ORDER BY "item_id", "version" DESC;--> statement-breakpoint
DROP TABLE "__old_item_wait";--> statement-breakpoint
DROP TABLE "queue_wait";--> statement-breakpoint
ALTER TABLE "item_wait" ADD CONSTRAINT "item_wait_item_id_work_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."work_item"("id") ON DELETE no action ON UPDATE no action;
