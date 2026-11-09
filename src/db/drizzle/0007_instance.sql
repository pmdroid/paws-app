CREATE TABLE `instance` (
	`id` text PRIMARY KEY NOT NULL,
	`role` text NOT NULL,
	`host` text NOT NULL,
	`started_at` integer NOT NULL,
	`heartbeat_at` integer NOT NULL,
	`version` text,
	CONSTRAINT "instance_role" CHECK(role IN ('all', 'web', 'worker'))
);
--> statement-breakpoint
CREATE INDEX `instance_heartbeat` ON `instance` (`heartbeat_at`);