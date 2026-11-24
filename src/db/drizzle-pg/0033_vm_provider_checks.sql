CREATE TABLE "vm_provider_check" (
	"name" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"message" text NOT NULL,
	"facts" jsonb NOT NULL,
	"checked_at" bigint NOT NULL,
	"last_working_at" bigint,
	CONSTRAINT "vm_provider_check_name" CHECK (name IN ('exe-dev','boat','instabox','tailscale')),
	CONSTRAINT "vm_provider_check_state" CHECK (state IN ('working','limited','rejected','unreachable'))
);
