CREATE TABLE "trace_export" (
	"item_id" text PRIMARY KEY NOT NULL,
	"ended_at" bigint NOT NULL,
	"exported_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trace_export" ADD CONSTRAINT "trace_export_item_id_work_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."work_item"("id") ON DELETE no action ON UPDATE no action;