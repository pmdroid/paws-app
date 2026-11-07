CREATE TABLE `runner_reservation` (
	`run_id` text PRIMARY KEY NOT NULL,
	`runner_id` text NOT NULL,
	`instance_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `run`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`runner_id`) REFERENCES `runner`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `runner_reservation_runner` ON `runner_reservation` (`runner_id`,`expires_at`);