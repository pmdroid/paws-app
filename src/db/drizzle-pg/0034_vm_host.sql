CREATE TABLE "vm_host" (
	"runner_id" text PRIMARY KEY NOT NULL,
	"vm_vcpus" integer DEFAULT 2 NOT NULL,
	"vm_memory_gb" integer DEFAULT 4 NOT NULL,
	"vm_disk_gb" integer DEFAULT 30 NOT NULL,
	"reserve_vcpus" integer DEFAULT 4 NOT NULL,
	"reserve_memory_gb" integer DEFAULT 8 NOT NULL,
	"slot_cap" integer,
	"updated_at" bigint NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "vm_host_vm_vcpus" CHECK (vm_vcpus BETWEEN 1 AND 32),
	CONSTRAINT "vm_host_vm_memory_gb" CHECK (vm_memory_gb BETWEEN 1 AND 128),
	CONSTRAINT "vm_host_vm_disk_gb" CHECK (vm_disk_gb BETWEEN 10 AND 500),
	CONSTRAINT "vm_host_reserve_vcpus" CHECK (reserve_vcpus BETWEEN 0 AND 64),
	CONSTRAINT "vm_host_reserve_memory_gb" CHECK (reserve_memory_gb BETWEEN 0 AND 256),
	CONSTRAINT "vm_host_slot_cap" CHECK (slot_cap IS NULL OR slot_cap BETWEEN 1 AND 64)
);
--> statement-breakpoint
ALTER TABLE "vm_host" ADD CONSTRAINT "vm_host_runner_id_runner_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runner"("id") ON DELETE no action ON UPDATE no action;