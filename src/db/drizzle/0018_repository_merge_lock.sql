CREATE TABLE `repository_merge_lock` (
	`repository` text PRIMARY KEY NOT NULL,
	`holder` text NOT NULL,
	`item_id` text NOT NULL,
	`job_id` integer NOT NULL,
	`instance_id` text,
	`acquired_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
