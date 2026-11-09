CREATE TABLE `__new_item_wait` (
	`item_id` text NOT NULL,
	`kind` text NOT NULL,
	`version` integer NOT NULL,
	`since` integer NOT NULL,
	PRIMARY KEY(`item_id`, `kind`),
	FOREIGN KEY (`item_id`) REFERENCES `work_item`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "item_wait_check_1" CHECK(kind IN ('queue','item'))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_item_wait`(`item_id`, `kind`, `version`, `since`) SELECT `item_id`, 'item', `version`, `since` FROM `item_wait`;--> statement-breakpoint
INSERT INTO `__new_item_wait`(`item_id`, `kind`, `version`, `since`) SELECT `item_id`, 'queue', `version`, `since` FROM `queue_wait` AS `wait` WHERE `version` = (SELECT max(`version`) FROM `queue_wait` WHERE `item_id` = `wait`.`item_id`);--> statement-breakpoint
DROP TABLE `item_wait`;--> statement-breakpoint
DROP TABLE `queue_wait`;--> statement-breakpoint
ALTER TABLE `__new_item_wait` RENAME TO `item_wait`;
