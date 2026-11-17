CREATE TABLE "context_summary" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" text NOT NULL,
	"partition" text NOT NULL,
	"audience" text NOT NULL,
	"audience_lineage" text NOT NULL,
	"restriction" jsonb NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"body" text NOT NULL,
	"body_bytes" integer NOT NULL,
	"covered" integer NOT NULL,
	"watermark" bigint,
	"generation" bigint,
	"requested_at" bigint,
	"lease_token" text,
	"lease_until" bigint,
	"claimed_at" bigint,
	"attempts" integer NOT NULL,
	"failure" text,
	"built_at" bigint,
	"changed_at" bigint NOT NULL,
	CONSTRAINT "context_summary_status" CHECK (status IN ('empty','current','invalidated'))
);
--> statement-breakpoint
CREATE TABLE "context_summary_source" (
	"summary_id" text NOT NULL,
	"record_id" text NOT NULL,
	"record_version" integer NOT NULL,
	CONSTRAINT "context_summary_source_pk" PRIMARY KEY("summary_id","record_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "context_summary_partition" ON "context_summary" USING btree ("workspace_id","scope_kind","scope_id","partition");--> statement-breakpoint
CREATE INDEX "context_summary_requested" ON "context_summary" USING btree ("requested_at");--> statement-breakpoint
CREATE INDEX "context_summary_source_record" ON "context_summary_source" USING btree ("record_id");