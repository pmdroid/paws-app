ALTER TABLE "github_delivery" ADD COLUMN "repository" text;--> statement-breakpoint
ALTER TABLE "github_delivery" ADD COLUMN "pull_number" integer;--> statement-breakpoint
WITH bodies AS (
  SELECT delivery_id, CASE WHEN payload IS JSON THEN payload::jsonb ELSE '{}'::jsonb END AS body
  FROM github_delivery
), metadata AS (
  SELECT delivery_id, body->'repository'->'full_name' AS repository,
    COALESCE(NULLIF(body->'pull_request'->'number', 'null'::jsonb), body->'issue'->'number') AS number
  FROM bodies
)
UPDATE github_delivery AS delivery SET
  repository = CASE WHEN jsonb_typeof(metadata.repository) = 'string' THEN lower(metadata.repository #>> '{}') END,
  pull_number = CASE WHEN jsonb_typeof(metadata.number) = 'number'
    AND (metadata.number #>> '{}')::numeric BETWEEN -2147483648 AND 2147483647
    AND trunc((metadata.number #>> '{}')::numeric) = (metadata.number #>> '{}')::numeric
    THEN (metadata.number #>> '{}')::numeric::integer END
FROM metadata WHERE delivery.delivery_id = metadata.delivery_id;
--> statement-breakpoint
ALTER TABLE "github_delivery" DROP COLUMN "payload";