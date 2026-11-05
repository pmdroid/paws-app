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

export function pullRequestDraftSavedAt(db: Database, itemId: string): number | null {
  return (
    db
      .query<{ updated_at: number }, [string]>(
        "SELECT updated_at FROM pull_request_draft WHERE item_id = ?",
      )
      .get(itemId)?.updated_at ?? null
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

export type PullRequestText = { title: string; body: string; evidence: string };

export function savePullRequestText(
  db: Database,
  itemId: string,
  text: PullRequestText,
  now: number,
): void {
  db.run(
    `INSERT INTO pull_request_text (item_id, title, body, evidence, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(item_id) DO UPDATE SET title = excluded.title, body = excluded.body,
       evidence = excluded.evidence, updated_at = excluded.updated_at`,
    [itemId, text.title, text.body, text.evidence, now],
  );
}

export function getPullRequestText(db: Database, itemId: string): PullRequestText | null {
  return (
    db
      .query<PullRequestText, [string]>(
        "SELECT title, body, evidence FROM pull_request_text WHERE item_id = ?",
      )
      .get(itemId) ?? null
  );
}
