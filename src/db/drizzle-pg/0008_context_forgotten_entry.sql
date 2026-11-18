CREATE TABLE "context_forgotten_entry" (
	"workspace_id" text NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"record_key" text NOT NULL,
	"forgotten_by" text NOT NULL,
	"forgotten_at" bigint NOT NULL,
	CONSTRAINT "context_forgotten_entry_pk" PRIMARY KEY("workspace_id","scope_kind","scope_id","source_kind","source_id","record_key")
);
