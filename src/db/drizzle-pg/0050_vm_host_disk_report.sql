CREATE TABLE "vm_host_disk_report" (
	"runner_id" text PRIMARY KEY NOT NULL,
	"disks" jsonb NOT NULL,
	"reported_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vm_host_disk_report" ADD CONSTRAINT "vm_host_disk_report_runner_id_vm_host_runner_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."vm_host"("runner_id") ON DELETE cascade ON UPDATE no action;