CREATE TABLE "context_session" (
	"consumer_key" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" text NOT NULL,
	"requester_id" text NOT NULL,
	"audience" text NOT NULL,
	"version" integer NOT NULL,
	"generation" bigint NOT NULL,
	"status" text NOT NULL,
	"pack_hash" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "context_session_status" CHECK (status IN ('injected','withheld')),
	CONSTRAINT "context_session_version" CHECK (version > 0)
);
--> statement-breakpoint
CREATE INDEX "context_session_scope" ON "context_session" USING btree ("workspace_id","scope_kind","scope_id");