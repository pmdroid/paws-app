CREATE TABLE `runner_file_object` (
	`key` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`command_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`digest` text NOT NULL,
	`sha256` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "runner_file_object_check_1" CHECK(kind IN ('input','artifact'))
);
--> statement-breakpoint
CREATE INDEX `runner_file_object_run` ON `runner_file_object` (`run_id`);--> statement-breakpoint
CREATE INDEX `runner_file_object_command` ON `runner_file_object` (`command_id`,`kind`);