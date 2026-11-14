ALTER TABLE "github_delivery" ADD COLUMN "repository" text;--> statement-breakpoint
ALTER TABLE "github_delivery" ADD COLUMN "pull_number" integer;--> statement-breakpoint
CREATE FUNCTION pg_temp.paws_delivery_metadata(payload text)
RETURNS TABLE(repository text, pull_number integer)
LANGUAGE plpgsql AS $$
DECLARE
  body json;
  pull_value json;
  pull_numeric numeric;
BEGIN
  BEGIN
    body := payload::json;
  EXCEPTION WHEN data_exception THEN
    RETURN NEXT;
    RETURN;
  END;
  SELECT string_agg(parts[1] || CASE
    WHEN parts[2] ~ '^\\u(0000|[dD][89a-fA-F][0-9a-fA-F]{2})$' THEN '\ufffd'
    ELSE parts[2] END, '' ORDER BY position)::json INTO body
  FROM regexp_matches(payload,
    '([^\\]*)(\\u[dD][89aAbB][0-9a-fA-F]{2}\\u[dD][c-fC-F][0-9a-fA-F]{2}|\\u[0-9a-fA-F]{4}|\\.|$)',
    'g') WITH ORDINALITY AS tokens(parts, position);
  BEGIN
    IF json_typeof(body->'repository'->'full_name') = 'string' THEN
      repository := lower(body->'repository'->>'full_name');
    END IF;
  EXCEPTION WHEN data_exception THEN
    repository := NULL;
  END;
  BEGIN
    pull_value := body->'pull_request'->'number';
    IF pull_value IS NULL OR json_typeof(pull_value) = 'null' THEN
      pull_value := body->'issue'->'number';
    END IF;
    IF json_typeof(pull_value) = 'number' THEN
      pull_numeric := pull_value::text::numeric;
      IF pull_numeric BETWEEN -2147483648 AND 2147483647 AND trunc(pull_numeric) = pull_numeric THEN
        pull_number := pull_numeric::integer;
      END IF;
    END IF;
  EXCEPTION WHEN data_exception THEN
    pull_number := NULL;
  END;
  RETURN NEXT;
END;
$$;
--> statement-breakpoint
WITH metadata AS (
  SELECT delivery_id, parsed.repository, parsed.pull_number
  FROM github_delivery CROSS JOIN LATERAL pg_temp.paws_delivery_metadata(payload) AS parsed
)
UPDATE github_delivery AS delivery SET
  repository = metadata.repository,
  pull_number = metadata.pull_number
FROM metadata WHERE delivery.delivery_id = metadata.delivery_id;
--> statement-breakpoint
DROP FUNCTION pg_temp.paws_delivery_metadata(text);
--> statement-breakpoint
ALTER TABLE "github_delivery" DROP COLUMN "payload";
