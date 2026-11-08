PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_item_hold` (
	`item_id` text PRIMARY KEY NOT NULL,
	`reason` text,
	`blockers` text NOT NULL,
	`files` text DEFAULT '[]' NOT NULL,
	`overlap_since` integer,
	FOREIGN KEY (`item_id`) REFERENCES `work_item`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "item_hold_check_1" CHECK(reason IN ('blocked','project','reconciling','snapshot','cap','slot','workspace','overlap')),
	CONSTRAINT "item_hold_check_2" CHECK(json_valid(blockers)),
	CONSTRAINT "item_hold_check_3" CHECK(json_valid(files))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_item_hold`("item_id", "reason", "blockers", "files") SELECT "item_id", "reason", "blockers", "files" FROM `item_hold`;--> statement-breakpoint
DROP TABLE `item_hold`;--> statement-breakpoint
ALTER TABLE `__new_item_hold` RENAME TO `item_hold`;--> statement-breakpoint
PRAGMA foreign_keys=ON;