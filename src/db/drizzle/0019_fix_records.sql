CREATE TABLE `fix_record` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`run_id` text,
	`linear_identifier` text NOT NULL,
	`repository` text,
	`reason` text NOT NULL,
	`triggers` text NOT NULL,
	`round` integer NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`outcome` text,
	`head_before` text,
	`head_after` text,
	`agent` text,
	`model` text,
	`duration_ms` integer,
	CONSTRAINT "fix_record_check_1" CHECK(reason IN ('ci', 'review', 'conflict', 'findings', 'suggested', 'follow_up')),
	CONSTRAINT "fix_record_check_2" CHECK(json_valid(triggers)),
	CONSTRAINT "fix_record_check_3" CHECK(outcome IN ('fixed', 'not_fixed', 'asked', 'abandoned'))
);
--> statement-breakpoint
CREATE INDEX `fix_record_item_open` ON `fix_record` (`item_id`,`ended_at`);--> statement-breakpoint
CREATE INDEX `fix_record_started` ON `fix_record` (`started_at`);