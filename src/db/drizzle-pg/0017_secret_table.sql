CREATE TABLE "secret" (
	"name" text PRIMARY KEY NOT NULL,
	"ciphertext" text NOT NULL,
	"updated_at" bigint NOT NULL
);
