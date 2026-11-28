WITH link AS (
  SELECT dedupe_key, upper((regexp_match(regexp_replace(payload->'mention'->>'text', '<@[A-Z0-9]+>', '', 'g'), '^\s*link\s+([A-Z2-7]{4}-[A-Z2-7]{4})[.!]?\s*$', 'i'))[1]) AS code
  FROM inbox_event
  WHERE payload->>'type' = 'SlackDirectMessage'
)
UPDATE inbox_event SET payload = jsonb_set(inbox_event.payload, '{mention,text}', '""') || jsonb_build_object('linkHash', encode(sha256(convert_to(link.code, 'UTF8')), 'hex'))
FROM link
WHERE inbox_event.dedupe_key = link.dedupe_key AND link.code IS NOT NULL;
