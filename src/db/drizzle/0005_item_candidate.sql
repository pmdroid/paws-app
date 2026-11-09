CREATE TABLE `item_candidate` (
	`item_id` text PRIMARY KEY NOT NULL,
	`sha` text NOT NULL,
	`branch` text NOT NULL,
	`recorded_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `work_item`(`id`) ON UPDATE no action ON DELETE no action
);
