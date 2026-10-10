import type { Database } from "bun:sqlite";

export type PollKind = "issues" | "comments";

export type PollState = {
  cursorMs: number;
  etag: string | null;
  url: string;
};

export function readPollState(db: Database, repo: string, kind: PollKind): PollState | null {
  const row = db
    .query<{ cursor_ms: number; etag: string | null; url: string }, [string, PollKind]>(
      `SELECT cursor_ms, etag, url FROM github_poll_state WHERE repo = ? AND kind = ?`,
    )
    .get(repo, kind);
  if (row === null) return null;
  return { cursorMs: row.cursor_ms, etag: row.etag, url: row.url };
}

export function writePollState(
  db: Database,
  repo: string,
  kind: PollKind,
  state: PollState,
  updatedAt: number,
): void {
  db.run(
    `INSERT INTO github_poll_state (repo, kind, cursor_ms, etag, url, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (repo, kind) DO UPDATE SET
       cursor_ms = excluded.cursor_ms,
       etag = excluded.etag,
       url = excluded.url,
       updated_at = excluded.updated_at`,
    [repo, kind, state.cursorMs, state.etag, state.url, updatedAt],
  );
}

export function hasSeen(db: Database, dedupeKey: string): boolean {
  const row = db
    .query<{ dedupe_key: string }, [string]>(
      `SELECT dedupe_key FROM github_seen WHERE dedupe_key = ?`,
    )
    .get(dedupeKey);
  return row !== null;
}

export function markSeen(db: Database, dedupeKey: string, seenAt: number): void {
  db.run(`INSERT OR IGNORE INTO github_seen (dedupe_key, seen_at) VALUES (?, ?)`, [
    dedupeKey,
    seenAt,
  ]);
}

/** Null when this issue has never been observed. */
export function readLabeled(db: Database, issueKey: string): 0 | 1 | null {
  const row = db
    .query<{ labeled: number }, [string]>(
      `SELECT labeled FROM github_label_state WHERE issue_key = ?`,
    )
    .get(issueKey);
  if (row === null) return null;
  return row.labeled === 1 ? 1 : 0;
}

export function writeLabeled(
  db: Database,
  issueKey: string,
  labeled: 0 | 1,
  updatedAt: number,
): void {
  db.run(
    `INSERT INTO github_label_state (issue_key, labeled, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT (issue_key) DO UPDATE SET
       labeled = excluded.labeled,
       updated_at = excluded.updated_at`,
    [issueKey, labeled, updatedAt],
  );
}
