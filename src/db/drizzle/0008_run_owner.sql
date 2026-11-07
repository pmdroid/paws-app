CREATE TABLE `run_owner` (
	`run_id` text PRIMARY KEY NOT NULL,
	`owner_instance` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `run`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `run_owner_instance` ON `run_owner` (`owner_instance`);--> statement-breakpoint
ALTER TABLE `instance` ADD `pid` integer;