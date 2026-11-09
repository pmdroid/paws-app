CREATE TABLE `credential` (
	`kind` text NOT NULL,
	`workspace` text NOT NULL,
	`ciphertext` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`kind`, `workspace`),
	CONSTRAINT "credential_kind" CHECK(kind IN ('linear', 'slack'))
);
