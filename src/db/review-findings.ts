import type { Database } from "bun:sqlite";
import { findingPlace, reviewFindingKey, type ReviewFindingStatus } from "../core";
import { immediate } from "./tx";

export type ReviewFindingSeverity = "P0" | "P1" | "P2" | "P3";
/** In code the change did not touch, or reported only because it is below the review's `failOn`. */
export type ReviewFindingWhy = "pre-existing" | "below failOn";

/** One non-blocking finding of a review at an accepted head. */
export type ReviewFindingReport = {
  review: string;
  severity: ReviewFindingSeverity;
  location: string;
  text: string;
  bugClass: string;
  why: ReviewFindingWhy;
};

export type ReviewFindingRecord = {
  id: number;
  key: string;
  /** `owner/repo`. */
  repository: string;
  path: string;
  /** `12` or `12-20`; empty when the location names no line. */
  lines: string;
  severity: ReviewFindingSeverity;
  review: string;
  text: string;
  bugClass: string;
  why: ReviewFindingWhy;
  first: { itemId: string; head: string; at: number };
  last: { itemId: string; head: string; at: number };
  itemCount: number;
  status: ReviewFindingStatus;
  /** Who set the status, or null when Paws did. */
  statusBy: string | null;
  statusAt: number | null;
  /** Why it was dismissed, or why Paws changed it. */
  statusReason: string | null;
  /** The Linear issue it was filed as. */
  filedIssue: string | null;
};

/** An item that reported a finding, with the head where it last did. */
export type ReviewFindingItem = {
  findingId: number;
  itemId: string;
  identifier: string;
  title: string;
  sessionKey: string | null;
  head: string;
  seenAt: number;
};

export type ReviewFindingFilter = {
  /** Findings reported by this item, optionally at one exact head. */
  itemId?: string;
  head?: string;
  repository?: string;
  severity?: ReviewFindingSeverity;
  review?: string;
  status?: ReviewFindingStatus;
  /** Paths that start with this. */
  pathPrefix?: string;
};

type Row = {
  id: number;
  dedupe_key: string;
  repository: string;
  path: string;
  lines: string;
  severity: ReviewFindingSeverity;
  review: string;
  text: string;
  bug_class: string;
  why: ReviewFindingWhy;
  first_item_id: string;
  first_head: string;
  first_seen_at: number;
  last_item_id: string;
  last_head: string;
  last_seen_at: number;
  item_count: number;
  status: ReviewFindingStatus;
  status_by: string | null;
  status_at: number | null;
  status_reason: string | null;
  filed_issue: string | null;
};

/**
 * Records the non-blocking findings of one accepted head of `itemId`. A finding another item
 * already reported updates its row: the item count when this item is new to it, and the last
 * item, head and time when this report is the latest. A finding Paws marked gone opens again.
 *
 * `reviewed` names, per review, the paths that review looked at on this head. An open finding of
 * that review on one of those paths that this head no longer reports, and was last seen before
 * `seenAt`, becomes gone.
 */
export function recordReviewFindings(
  db: Database,
  input: {
    itemId: string;
    /** `owner/repo`. */
    repository: string;
    head: string;
    seenAt: number;
    findings: readonly ReviewFindingReport[];
    reviewed: readonly { review: string; paths: readonly string[] }[];
  },
): { recorded: number; gone: number } {
  return immediate(db, () => {
    const keys = new Set<string>();
    for (const finding of input.findings) {
      const key = reviewFindingKey({
        repository: input.repository,
        location: finding.location,
        text: finding.text,
      });
      if (keys.has(key)) continue;
      keys.add(key);
      upsert(db, input, finding, key);
    }
    let gone = 0;
    for (const review of input.reviewed) {
      const paths = [...new Set(review.paths.map((path) => findingPlace(path).path))];
      if (paths.length === 0) continue;
      gone += db.run(
        `UPDATE review_finding SET status = 'gone', status_by = NULL, status_at = ?1,
           status_reason = 'A later accepted review of this path no longer reported it.'
         WHERE status = 'open' AND repository = ?2 AND review = ?3 AND last_seen_at < ?1
           AND path IN (SELECT value FROM json_each(?4))
           AND dedupe_key NOT IN (SELECT value FROM json_each(?5))`,
        [
          input.seenAt,
          input.repository,
          review.review,
          JSON.stringify(paths),
          JSON.stringify([...keys]),
        ],
      ).changes;
    }
    return { recorded: keys.size, gone };
  });
}

function upsert(
  db: Database,
  input: { itemId: string; repository: string; head: string; seenAt: number },
  finding: ReviewFindingReport,
  key: string,
): void {
  const place = findingPlace(finding.location);
  const existing = db
    .query<Pick<Row, "id" | "first_seen_at" | "last_seen_at" | "status">, [string]>(
      "SELECT id, first_seen_at, last_seen_at, status FROM review_finding WHERE dedupe_key = ?",
    )
    .get(key);
  if (existing === null) {
    const row = db
      .query<{ id: number }, (string | number | null)[]>(
        `INSERT INTO review_finding (
           dedupe_key, repository, path, lines, first_line, severity, review, text, bug_class, why,
           first_item_id, first_head, first_seen_at, last_item_id, last_head, last_seen_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        key,
        input.repository,
        place.path,
        place.lines,
        place.firstLine,
        finding.severity,
        finding.review,
        finding.text,
        finding.bugClass,
        finding.why,
        input.itemId,
        input.head,
        input.seenAt,
        input.itemId,
        input.head,
        input.seenAt,
      )!;
    linkItem(db, row.id, input);
    return;
  }
  const latest = input.seenAt >= existing.last_seen_at;
  if (latest)
    db.run(
      `UPDATE review_finding SET severity = ?, review = ?, text = ?, bug_class = ?, why = ?,
         last_item_id = ?, last_head = ?, last_seen_at = ? WHERE id = ?`,
      [
        finding.severity,
        finding.review,
        finding.text,
        finding.bugClass,
        finding.why,
        input.itemId,
        input.head,
        input.seenAt,
        existing.id,
      ],
    );
  if (input.seenAt < existing.first_seen_at)
    db.run(
      "UPDATE review_finding SET first_item_id = ?, first_head = ?, first_seen_at = ? WHERE id = ?",
      [input.itemId, input.head, input.seenAt, existing.id],
    );
  if (existing.status === "gone" && input.seenAt > existing.last_seen_at)
    db.run(
      `UPDATE review_finding SET status = 'open', status_by = NULL, status_at = ?,
         status_reason = 'A later accepted review reported it again.' WHERE id = ?`,
      [input.seenAt, existing.id],
    );
  if (linkItem(db, existing.id, input))
    db.run("UPDATE review_finding SET item_count = item_count + 1 WHERE id = ?", [existing.id]);
}

/** Links the item to the finding; true when the item had not reported it before. */
function linkItem(
  db: Database,
  findingId: number,
  input: { itemId: string; head: string; seenAt: number },
): boolean {
  const inserted = db.run(
    `INSERT OR IGNORE INTO review_finding_item (finding_id, item_id, head_sha, seen_at)
     VALUES (?, ?, ?, ?)`,
    [findingId, input.itemId, input.head, input.seenAt],
  ).changes;
  if (inserted > 0) return true;
  db.run(
    `UPDATE review_finding_item SET head_sha = ?, seen_at = ?
     WHERE finding_id = ? AND item_id = ? AND seen_at <= ?`,
    [input.head, input.seenAt, findingId, input.itemId, input.seenAt],
  );
  return false;
}

/** The findings that match `filter`, newest last seen first. */
export function listReviewFindings(
  db: Database,
  filter: ReviewFindingFilter = {},
): ReviewFindingRecord[] {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.itemId) {
    where.push(
      "EXISTS (SELECT 1 FROM review_finding_item l WHERE l.finding_id = review_finding.id AND l.item_id = ?" +
        (filter.head ? " AND l.head_sha = ?" : "") +
        ")",
    );
    params.push(filter.itemId);
    if (filter.head) params.push(filter.head);
  }
  if (filter.repository) {
    where.push("repository = ?");
    params.push(filter.repository);
  }
  if (filter.severity) {
    where.push("severity = ?");
    params.push(filter.severity);
  }
  if (filter.review) {
    where.push("review = ?");
    params.push(filter.review);
  }
  if (filter.status) {
    where.push("status = ?");
    params.push(filter.status);
  }
  if (filter.pathPrefix) {
    where.push("substr(path, 1, length(?)) = ?");
    params.push(filter.pathPrefix, filter.pathPrefix);
  }
  return db
    .query<Row, string[]>(
      `SELECT * FROM review_finding ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY last_seen_at DESC, id DESC`,
    )
    .all(...params)
    .map(mapRow);
}

export function getReviewFinding(db: Database, id: number): ReviewFindingRecord | null {
  const row = db.query<Row, [number]>("SELECT * FROM review_finding WHERE id = ?").get(id);
  return row === null ? null : mapRow(row);
}

/** The finding with `reviewFindingKey` `key`, as filing an issue from it finds it. */
export function getReviewFindingByKey(db: Database, key: string): ReviewFindingRecord | null {
  const row = db.query<Row, [string]>("SELECT * FROM review_finding WHERE dedupe_key = ?").get(key);
  return row === null ? null : mapRow(row);
}

/** The items that reported each finding in `ids`, latest first. */
export function reviewFindingItems(
  db: Database,
  ids: readonly number[],
): Map<number, ReviewFindingItem[]> {
  const byFinding = new Map<number, ReviewFindingItem[]>();
  if (ids.length === 0) return byFinding;
  const rows = db
    .query<ReviewFindingItem, [string]>(
      `SELECT l.finding_id AS findingId, l.item_id AS itemId, w.linear_identifier AS identifier,
         w.title, w.session_key AS sessionKey, l.head_sha AS head, l.seen_at AS seenAt
       FROM review_finding_item l JOIN work_item w ON w.id = l.item_id
       WHERE l.finding_id IN (SELECT value FROM json_each(?))
       ORDER BY l.seen_at DESC, l.item_id`,
    )
    .all(JSON.stringify(ids));
  for (const row of rows) {
    const list = byFinding.get(row.findingId) ?? [];
    list.push(row);
    byFinding.set(row.findingId, list);
  }
  return byFinding;
}

/**
 * A member dismisses a finding with a reason, or reopens a dismissed one. Null when the finding
 * does not exist or is not in a state that change applies to: only an open or gone finding is
 * dismissed, and only a dismissed one reopens.
 */
export function setReviewFindingStatus(
  db: Database,
  input:
    | { id: number; status: "dismissed"; reason: string; by: string; now: number }
    | { id: number; status: "open"; by: string; now: number },
): ReviewFindingRecord | null {
  const from = input.status === "dismissed" ? ["open", "gone"] : ["dismissed"];
  const changed = db.run(
    `UPDATE review_finding SET status = ?, status_by = ?, status_at = ?, status_reason = ?
     WHERE id = ? AND status IN (SELECT value FROM json_each(?))`,
    [
      input.status,
      input.by,
      input.now,
      input.status === "dismissed" ? input.reason : null,
      input.id,
      JSON.stringify(from),
    ],
  ).changes;
  return changed > 0 ? getReviewFinding(db, input.id) : null;
}

/**
 * Marks the finding with `reviewFindingKey` `key` filed as the Linear issue `issue`. Filing an
 * issue from the Findings page calls it. Null when no finding has that key.
 */
export function markReviewFindingFiled(
  db: Database,
  input: { key: string; issue: string; by: string | null; now: number },
): ReviewFindingRecord | null {
  const changed = db.run(
    `UPDATE review_finding SET status = 'filed', filed_issue = ?, status_by = ?, status_at = ?,
       status_reason = NULL WHERE dedupe_key = ?`,
    [input.issue, input.by, input.now, input.key],
  ).changes;
  return changed > 0 ? getReviewFindingByKey(db, input.key) : null;
}

function mapRow(row: Row): ReviewFindingRecord {
  return {
    id: row.id,
    key: row.dedupe_key,
    repository: row.repository,
    path: row.path,
    lines: row.lines,
    severity: row.severity,
    review: row.review,
    text: row.text,
    bugClass: row.bug_class,
    why: row.why,
    first: { itemId: row.first_item_id, head: row.first_head, at: row.first_seen_at },
    last: { itemId: row.last_item_id, head: row.last_head, at: row.last_seen_at },
    itemCount: row.item_count,
    status: row.status,
    statusBy: row.status_by,
    statusAt: row.status_at,
    statusReason: row.status_reason,
    filedIssue: row.filed_issue,
  };
}

/** Read a bounded member set without scanning the global findings table. */
export function reviewFindingsByIds(db: Database, ids: readonly number[]): ReviewFindingRecord[] {
  if (!ids.length) return [];
  return db
    .query<Row, [string]>(
      "SELECT * FROM review_finding WHERE id IN (SELECT value FROM json_each(?))",
    )
    .all(JSON.stringify(ids))
    .map(mapRow);
}
