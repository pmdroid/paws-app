CREATE TABLE "linear_conversation_entry" (
	"item_id" text NOT NULL,
	"position" integer NOT NULL,
	"entry" jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "linear_conversation_entry_item_id_position_pk" PRIMARY KEY("item_id","position")
);
--> statement-breakpoint
ALTER TABLE "linear_conversation_entry" ADD CONSTRAINT "linear_conversation_entry_item_id_linear_conversation_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."linear_conversation"("item_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "linear_conversation_entry" ("item_id", "position", "entry", "created_at") SELECT c."item_id", e.ordinality - 1, e.value, (extract(epoch from now()) * 1000)::bigint FROM "linear_conversation" c CROSS JOIN LATERAL jsonb_array_elements(c."entries") WITH ORDINALITY AS e(value, ordinality) WHERE jsonb_typeof(c."entries") = 'array';--> statement-breakpoint
ALTER TABLE "linear_conversation" DROP COLUMN "entries";