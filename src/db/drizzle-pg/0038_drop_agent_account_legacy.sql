UPDATE "runner_login" SET "binding_id" = NULL WHERE "binding_id" IN (SELECT "id" FROM "agent_account_binding" WHERE "legacy" = 1 OR "account_id" IN (SELECT "id" FROM "agent_account" WHERE "legacy" = 1));--> statement-breakpoint
DELETE FROM "agent_account_health" WHERE "binding_id" IN (SELECT "id" FROM "agent_account_binding" WHERE "legacy" = 1 OR "account_id" IN (SELECT "id" FROM "agent_account" WHERE "legacy" = 1)) OR "scope_id" IN (SELECT "id" FROM "agent_account" WHERE "legacy" = 1);--> statement-breakpoint
DELETE FROM "runner_command_account" WHERE "binding_id" IN (SELECT "id" FROM "agent_account_binding" WHERE "legacy" = 1) OR "account_id" IN (SELECT "id" FROM "agent_account" WHERE "legacy" = 1);--> statement-breakpoint
DELETE FROM "agent_account_credential" WHERE "account_id" IN (SELECT "id" FROM "agent_account" WHERE "legacy" = 1);--> statement-breakpoint
DELETE FROM "agent_account_lease" WHERE "account_id" IN (SELECT "id" FROM "agent_account" WHERE "legacy" = 1);--> statement-breakpoint
DELETE FROM "agent_account_usage" WHERE "account_id" IN (SELECT "id" FROM "agent_account" WHERE "legacy" = 1);--> statement-breakpoint
DELETE FROM "agent_account_binding" WHERE "legacy" = 1 OR "account_id" IN (SELECT "id" FROM "agent_account" WHERE "legacy" = 1);--> statement-breakpoint
DELETE FROM "agent_account" WHERE "legacy" = 1;--> statement-breakpoint
ALTER TABLE "agent_account" DROP CONSTRAINT "agent_account_check_4";--> statement-breakpoint
ALTER TABLE "agent_account_binding" DROP CONSTRAINT "agent_account_binding_check_2";--> statement-breakpoint
ALTER TABLE "agent_account_binding" DROP CONSTRAINT "agent_account_binding_check_4";--> statement-breakpoint
DROP INDEX "agent_account_legacy";--> statement-breakpoint
DROP INDEX "agent_binding_legacy";--> statement-breakpoint
ALTER TABLE "agent_account" DROP COLUMN "legacy";--> statement-breakpoint
ALTER TABLE "agent_account_binding" DROP COLUMN "legacy";