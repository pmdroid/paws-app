CREATE TABLE `agent_account_credential` (
	`account_id` text PRIMARY KEY NOT NULL,
	`agent` text NOT NULL,
	`ciphertext` text NOT NULL,
	`version` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`runner_id` text,
	FOREIGN KEY (`account_id`) REFERENCES `agent_account`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`runner_id`) REFERENCES `runner`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `agent_account_lease` (
	`account_id` text PRIMARY KEY NOT NULL,
	`runner_id` text NOT NULL,
	`run_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `agent_account`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`runner_id`) REFERENCES `runner`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `agent_account_usage` (
	`account_id` text PRIMARY KEY NOT NULL,
	`runner_id` text NOT NULL,
	`limits_json` text NOT NULL,
	`observed_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `agent_account`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`runner_id`) REFERENCES `runner`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `agent_account` ADD `position` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_account` ADD `extra_usage` integer DEFAULT 0 NOT NULL;