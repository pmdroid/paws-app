ALTER TABLE `inbox_event` ADD `locked_by` text;--> statement-breakpoint
ALTER TABLE `inbox_event` ADD `locked_until` integer;