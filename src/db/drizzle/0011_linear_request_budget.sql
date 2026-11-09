CREATE TABLE `linear_request_budget` (
	`workspace` text PRIMARY KEY NOT NULL,
	`window_start` integer NOT NULL,
	`spent` integer NOT NULL,
	`hold_until` integer,
	`request_limit` integer
);
--> statement-breakpoint
CREATE TABLE `linear_request_reservation` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `linear_request_reservation_workspace` ON `linear_request_reservation` (`workspace`,`expires_at`);