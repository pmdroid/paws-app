DELETE FROM "context_summary_source" WHERE "summary_id" IN (SELECT "id" FROM "context_summary" WHERE "scope_kind" = 'slack_channel');--> statement-breakpoint
DELETE FROM "context_summary" WHERE "scope_kind" = 'slack_channel';--> statement-breakpoint
DELETE FROM "context_record" WHERE "scope_kind" = 'slack_channel';--> statement-breakpoint
DELETE FROM "context_source" WHERE "scope_kind" = 'slack_channel';--> statement-breakpoint
DELETE FROM "context_session" WHERE "scope_kind" = 'slack_channel';--> statement-breakpoint
DELETE FROM "context_audit" WHERE "scope_kind" = 'slack_channel';--> statement-breakpoint
DELETE FROM "context_scope" WHERE "scope_kind" = 'slack_channel';
