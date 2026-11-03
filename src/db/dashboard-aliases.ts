import type { Database } from "bun:sqlite";

export type DashboardAliasKind = "runs" | "sessions" | "verdicts";

const VISIBLE = `WITH visible AS (
  SELECT id,
         CASE WHEN coalesce(trim(linear_identifier), '') = '' THEN id
              ELSE trim(linear_identifier) END AS public_id,
         session_key,
         created_at
  FROM work_item
  WHERE ?1 IS NULL OR session_key IN (SELECT value FROM json_each(?1))
)`;

export function resolveDashboardAlias(
  db: Database,
  kind: DashboardAliasKind,
  id: string,
  sessionIds?: readonly string[],
): string | null {
  const scope = sessionIds === undefined ? null : JSON.stringify(sessionIds);
  const one = (sql: string) =>
    db.query<{ public_id: string }, [string | null, string]>(`${VISIBLE} ${sql}`).get(scope, id)
      ?.public_id ?? null;
  const run = () =>
    one("SELECT v.public_id FROM run r JOIN visible v ON v.id = r.item_id WHERE r.id = ?2");
  switch (kind) {
    case "runs":
      return run();
    case "sessions":
      return one(
        "SELECT public_id FROM visible WHERE session_key = ?2 ORDER BY created_at, id LIMIT 1",
      );
    case "verdicts":
      return one("SELECT public_id FROM visible WHERE public_id = ?2 LIMIT 1") ?? run();
  }
}
