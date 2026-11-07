CREATE TABLE `closeout_evidence_object` (
	`task` text NOT NULL,
	`path` text NOT NULL,
	`prefix` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`modified_at` integer NOT NULL,
	`stored_at` integer NOT NULL,
	PRIMARY KEY(`task`, `path`)
);
--> statement-breakpoint
CREATE TABLE `evidence_object` (
	`id` text PRIMARY KEY NOT NULL,
	`prefix` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`stored_at` integer NOT NULL
);
