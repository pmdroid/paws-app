CREATE TABLE "storage_snapshot" (
	"id" text PRIMARY KEY NOT NULL,
	"machine" text NOT NULL,
	"taken_at" bigint NOT NULL,
	"partial" boolean NOT NULL,
	"filesystems" jsonb NOT NULL,
	"categories" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "storage_snapshot_machine_taken_at" ON "storage_snapshot" USING btree ("machine","taken_at");