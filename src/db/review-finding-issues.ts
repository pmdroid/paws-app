import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

/** Where a finding points: its path and its line, or `first-last`. */
export type ReviewFindingPlace = { path: string; lines: string };

/** The Linear issue filed from a pre-existing review finding. */
export type ReviewFindingIssue = {
  key: string;
  repository: string;
  path: string;
  lines: string;
  linearIssueId: string;
  identifier: string;
  url: string | null;
  itemId: string | null;
  filedBy: string | null;
  filedAt: number;
};

/**
 * The path and lines of `path:line`, `path:line:column` or `path:first-last`, read as
 * Closeout reads a finding location. Null for anything else.
 */
export function reviewFindingPlace(location: string): ReviewFindingPlace | null {
  const match = /^(.+?):(\d+)(?:-(\d+)|:\d+)?$/.exec(location.trim());
  if (!match) return null;
  let path = match[1]!.trim().replace(/^`|`$/g, "");
  if (path.startsWith("./")) path = path.slice(2);
  const first = Number(match[2]);
  const last = match[3] === undefined ? first : Number(match[3]);
  if (path.length === 0 || path.startsWith("/") || first < 1) return null;
  return { path, lines: last > first ? `${first}-${last}` : String(first) };
}

/**
 * The key a filed issue is stored under: the repository, path, line range and finding text.
 * Null when the location names no line.
 */
export function reviewFindingKey(input: {
  repository: string;
  location: string;
  text: string;
}): string | null {
  const place = reviewFindingPlace(input.location);
  if (place === null) return null;
  return createHash("sha256")
    .update(JSON.stringify([input.repository, place.path, place.lines, input.text.trim()]))
    .digest("hex");
}

type Row = {
  key: string;
  repository: string;
  path: string;
  lines: string;
  linear_issue_id: string;
  identifier: string;
  url: string | null;
  item_id: string | null;
  filed_by: string | null;
  filed_at: number;
};

const fromRow = (row: Row): ReviewFindingIssue => ({
  key: row.key,
  repository: row.repository,
  path: row.path,
  lines: row.lines,
  linearIssueId: row.linear_issue_id,
  identifier: row.identifier,
  url: row.url,
  itemId: row.item_id,
  filedBy: row.filed_by,
  filedAt: row.filed_at,
});

export function getReviewFindingIssue(db: Database, key: string): ReviewFindingIssue | null {
  const row = db.query<Row, [string]>("SELECT * FROM review_finding_issue WHERE key=?").get(key);
  return row === null ? null : fromRow(row);
}

/** The filed issues of `keys`, by key. */
export function reviewFindingIssues(
  db: Database,
  keys: readonly string[],
): Map<string, ReviewFindingIssue> {
  const unique = [...new Set(keys)];
  const found = new Map<string, ReviewFindingIssue>();
  for (let start = 0; start < unique.length; start += 500) {
    const chunk = unique.slice(start, start + 500);
    const rows = db
      .query<Row, string[]>(
        `SELECT * FROM review_finding_issue WHERE key IN (${chunk.map(() => "?").join(",")})`,
      )
      .all(...chunk);
    for (const row of rows) found.set(row.key, fromRow(row));
  }
  return found;
}

/** Stores the filed issue unless one is already stored for its key; returns the stored one. */
export function saveReviewFindingIssue(
  db: Database,
  issue: ReviewFindingIssue,
): ReviewFindingIssue {
  db.run(
    `INSERT INTO review_finding_issue
    (key, repository, path, lines, linear_issue_id, identifier, url, item_id, filed_by, filed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(key) DO NOTHING`,
    [
      issue.key,
      issue.repository,
      issue.path,
      issue.lines,
      issue.linearIssueId,
      issue.identifier,
      issue.url,
      issue.itemId,
      issue.filedBy,
      issue.filedAt,
    ],
  );
  return getReviewFindingIssue(db, issue.key)!;
}
