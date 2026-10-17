import type { Database } from "bun:sqlite";

export type PullRequestDraft = { title: string; body: string };

export function savePullRequestDraft(
  db: Database,
  itemId: string,
  draft: PullRequestDraft,
  now: number,
): void {
  db.run(
    `INSERT INTO pull_request_draft (item_id, title, body, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(item_id) DO UPDATE SET title = excluded.title, body = excluded.body, updated_at = excluded.updated_at`,
    [itemId, draft.title, draft.body, now],
  );
}

export function getPullRequestDraft(db: Database, itemId: string): PullRequestDraft | null {
  return (
    db
      .query<PullRequestDraft, [string]>(
        "SELECT title, body FROM pull_request_draft WHERE item_id = ?",
      )
      .get(itemId) ?? null
  );
}
