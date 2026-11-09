CREATE TABLE "runner_reservation" (
	"run_id" text PRIMARY KEY NOT NULL,
	"runner_id" text NOT NULL,
	"instance_id" text NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runner_reservation" ADD CONSTRAINT "runner_reservation_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_reservation" ADD CONSTRAINT "runner_reservation_runner_id_runner_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runner_reservation_runner" ON "runner_reservation" USING btree ("runner_id","expires_at");