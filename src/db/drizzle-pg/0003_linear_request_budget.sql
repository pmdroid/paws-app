CREATE TABLE "linear_request_budget" (
	"workspace" text PRIMARY KEY NOT NULL,
	"window_start" bigint NOT NULL,
	"spent" bigint NOT NULL,
	"hold_until" bigint,
	"request_limit" bigint
);
--> statement-breakpoint
CREATE TABLE "linear_request_reservation" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace" text NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "linear_request_reservation_workspace" ON "linear_request_reservation" USING btree ("workspace","expires_at");