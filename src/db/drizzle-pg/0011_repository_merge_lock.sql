CREATE TABLE "repository_merge_lock" (
	"repository" text PRIMARY KEY NOT NULL,
	"holder" text NOT NULL,
	"item_id" text NOT NULL,
	"job_id" bigint NOT NULL,
	"instance_id" text,
	"acquired_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL
);
