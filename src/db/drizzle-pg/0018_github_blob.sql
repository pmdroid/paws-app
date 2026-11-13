CREATE TABLE "github_blob" (
	"sha" text PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"cached_at" bigint NOT NULL
);
