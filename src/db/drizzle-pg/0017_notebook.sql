CREATE TABLE "notebook" (
	"workspace_id" text NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" text NOT NULL,
	"revision" integer NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "notebook_workspace_id_scope_kind_scope_id_pk" PRIMARY KEY("workspace_id","scope_kind","scope_id"),
	CONSTRAINT "notebook_scope_kind" CHECK (scope_kind IN ('repository', 'project'))
);
--> statement-breakpoint
CREATE TABLE "notebook_change" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" text NOT NULL,
	"entry_id" text NOT NULL,
	"action" text NOT NULL,
	"before" text,
	"after" text,
	"item_id" text,
	"actor_id" text,
	"at" bigint NOT NULL,
	CONSTRAINT "notebook_change_action" CHECK (action IN ('add', 'patch', 'remove'))
);
--> statement-breakpoint
CREATE TABLE "notebook_entry" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "notebook_change_scope" ON "notebook_change" USING btree ("workspace_id","scope_kind","scope_id","id");--> statement-breakpoint
CREATE INDEX "notebook_entry_scope" ON "notebook_entry" USING btree ("workspace_id","scope_kind","scope_id","id");