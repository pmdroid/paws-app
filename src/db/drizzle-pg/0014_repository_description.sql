CREATE TABLE "repository_description" (
	"workspace_id" text NOT NULL,
	"repository" text NOT NULL,
	"text" text NOT NULL,
	"source" text NOT NULL,
	"content_hash" text,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "repository_description_workspace_id_repository_pk" PRIMARY KEY("workspace_id","repository"),
	CONSTRAINT "repository_description_check_1" CHECK (source IN ('paws','admin','github'))
);
