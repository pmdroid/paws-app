CREATE TABLE `__keep_review_finding_item` AS SELECT `finding_id`, `item_id`, `head_sha`, `seen_at` FROM `review_finding_item`;--> statement-breakpoint
CREATE TABLE `__new_review_finding` (
	`id` integer PRIMARY KEY NOT NULL,
	`dedupe_key` text NOT NULL,
	`repository` text NOT NULL,
	`path` text NOT NULL,
	`lines` text NOT NULL,
	`first_line` integer,
	`severity` text NOT NULL,
	`review` text NOT NULL,
	`text` text NOT NULL,
	`bug_class` text NOT NULL,
	`why` text NOT NULL,
	`first_item_id` text NOT NULL,
	`first_head` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_item_id` text NOT NULL,
	`last_head` text NOT NULL,
	`last_seen_at` integer NOT NULL,
	`item_count` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`status_by` text,
	`status_at` integer,
	`status_reason` text,
	`filed_issue` text,
	FOREIGN KEY (`first_item_id`) REFERENCES `work_item`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`last_item_id`) REFERENCES `work_item`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "review_finding_check_1" CHECK(severity IN ('P0', 'P1', 'P2', 'P3')),
	CONSTRAINT "review_finding_check_2" CHECK(why IN ('pre-existing', 'below failOn', 'meets failOn')),
	CONSTRAINT "review_finding_check_3" CHECK(status IN ('open', 'filed', 'dismissed', 'gone'))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_review_finding`("id", "dedupe_key", "repository", "path", "lines", "first_line", "severity", "review", "text", "bug_class", "why", "first_item_id", "first_head", "first_seen_at", "last_item_id", "last_head", "last_seen_at", "item_count", "status", "status_by", "status_at", "status_reason", "filed_issue") SELECT "id", "dedupe_key", "repository", "path", "lines", "first_line", "severity", "review", "text", "bug_class", "why", "first_item_id", "first_head", "first_seen_at", "last_item_id", "last_head", "last_seen_at", "item_count", "status", "status_by", "status_at", "status_reason", "filed_issue" FROM `review_finding`;--> statement-breakpoint
DROP TABLE `review_finding`;--> statement-breakpoint
ALTER TABLE `__new_review_finding` RENAME TO `review_finding`;--> statement-breakpoint
INSERT INTO `review_finding_item`(`finding_id`, `item_id`, `head_sha`, `seen_at`) SELECT `finding_id`, `item_id`, `head_sha`, `seen_at` FROM `__keep_review_finding_item`;--> statement-breakpoint
DROP TABLE `__keep_review_finding_item`;--> statement-breakpoint
CREATE INDEX `review_finding_last_seen` ON `review_finding` (`status`,`last_seen_at` DESC);--> statement-breakpoint
CREATE INDEX `review_finding_path` ON `review_finding` (`repository`,`review`,`path`);--> statement-breakpoint
CREATE UNIQUE INDEX `review_finding_dedupe_key_unique` ON `review_finding` (`dedupe_key`);