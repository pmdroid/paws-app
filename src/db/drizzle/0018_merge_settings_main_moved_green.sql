PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_work_item_merge_settings` (
	`item_id` text PRIMARY KEY NOT NULL,
	`merge_order` text NOT NULL,
	`main_moved` text NOT NULL,
	`resolved_json` text NOT NULL,
	`resolved_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `work_item`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "work_item_merge_settings_check_1" CHECK(merge_order IN ('queue','ci-green','github-queue')),
	CONSTRAINT "work_item_merge_settings_check_2" CHECK(main_moved IN ('overlap','green','ci','closeout'))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_work_item_merge_settings`("item_id", "merge_order", "main_moved", "resolved_json", "resolved_at") SELECT "item_id", "merge_order", "main_moved", "resolved_json", "resolved_at" FROM `work_item_merge_settings`;--> statement-breakpoint
DROP TABLE `work_item_merge_settings`;--> statement-breakpoint
ALTER TABLE `__new_work_item_merge_settings` RENAME TO `work_item_merge_settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;