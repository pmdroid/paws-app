CREATE TABLE "context_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" text NOT NULL,
	"action" text NOT NULL,
	"actor_id" text,
	"source_kind" text,
	"source_id" text,
	"at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_record" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"source_url" text,
	"source_revision" text NOT NULL,
	"source_revision_at" bigint NOT NULL,
	"actor_id" text,
	"observed_at" bigint NOT NULL,
	"record_key" text NOT NULL,
	"layer" text NOT NULL,
	"classification" text NOT NULL,
	"importance" integer NOT NULL,
	"body" text NOT NULL,
	"body_bytes" integer NOT NULL,
	"content_hash" text NOT NULL,
	"audience" text NOT NULL,
	"audience_lineage" text NOT NULL,
	"restriction" jsonb NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"supersedes" text,
	"corrected_by" text,
	"invalidated_reason" text,
	"invalidated_at" bigint,
	"expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "context_record_layer" CHECK (layer IN ('source_text','observation','summary')),
	CONSTRAINT "context_record_classification" CHECK (classification IN ('decision','verified_fact','reported_fact','inference','unresolved_question')),
	CONSTRAINT "context_record_status" CHECK (status IN ('current','superseded','invalidated'))
);
--> statement-breakpoint
CREATE TABLE "context_scope" (
	"workspace_id" text NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" text NOT NULL,
	"status" text NOT NULL,
	"generation" bigint NOT NULL,
	"changed_at" bigint NOT NULL,
	CONSTRAINT "context_scope_pk" PRIMARY KEY("workspace_id","scope_kind","scope_id"),
	CONSTRAINT "context_scope_kind" CHECK (scope_kind IN ('linear_project','slack_channel','user_private')),
	CONSTRAINT "context_scope_status" CHECK (status IN ('connected','disconnected'))
);
--> statement-breakpoint
CREATE TABLE "context_source" (
	"workspace_id" text NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"status" text NOT NULL,
	"revision" text,
	"revision_at" bigint,
	"blocked_through" bigint,
	"restriction" jsonb NOT NULL,
	"changed_by" text,
	"changed_at" bigint NOT NULL,
	"verified_at" bigint,
	CONSTRAINT "context_source_pk" PRIMARY KEY("workspace_id","scope_kind","scope_id","source_kind","source_id"),
	CONSTRAINT "context_source_status" CHECK (status IN ('active','unverified','forgotten','deleted','revoked','expired','disconnected'))
);
--> statement-breakpoint
CREATE INDEX "context_audit_scope" ON "context_audit" USING btree ("workspace_id","scope_kind","scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "context_record_version" ON "context_record" USING btree ("workspace_id","scope_kind","scope_id","source_kind","source_id","record_key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "context_record_current" ON "context_record" USING btree ("workspace_id","scope_kind","scope_id","source_kind","source_id","record_key") WHERE status = 'current';--> statement-breakpoint
CREATE INDEX "context_record_select" ON "context_record" USING btree ("workspace_id","scope_kind","scope_id","status","importance","observed_at");--> statement-breakpoint
CREATE INDEX "context_record_workspace" ON "context_record" USING btree ("workspace_id","status");