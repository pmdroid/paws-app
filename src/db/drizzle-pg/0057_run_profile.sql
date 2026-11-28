CREATE TABLE "run_profile" (
	"run_id" text PRIMARY KEY NOT NULL,
	"record" jsonb NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_profile" ADD CONSTRAINT "run_profile_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE cascade ON UPDATE no action;