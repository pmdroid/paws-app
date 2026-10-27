import type { Database } from "bun:sqlite";

/** What started a fix round after the pull request: failed CI, a changes-requested review, or comments. */
export type ReviewEscapeTrigger = "ci" | "review" | "comment";

/** Why a settled candidate does not count against the independent review. */
export type NotEscapeReason =
  /** Every failed check also fails on main. */
  | "flake"
  /** The fix only touched tests, docs or formatting. */
  | "tests_docs_format"
  /** The fix changed nothing. */
  | "no_change"
  /** A review or comment fix changed none of the files the independent review saw. */
  | "unreviewed";

export type ReviewEscapeDetail = {
  /** The failed checks, for `ci`. `failsOnBase` is true when the same check fails on main. */
  checks?: { name: string; failsOnBase: boolean }[];
  /** The review or comments, for `review` and `comment`. */
  comments?: { id: number; author: string | null; body: string }[];
};

export type ReviewEscapeRecord = {
  id: number;
  /** The restart's job key; one candidate per fix round. */
  triggerKey: string;
  itemId: string;
  trigger: ReviewEscapeTrigger;
  /** The head Closeout accepted before the fix round. */
  acceptedHead: string;
  pullNumber: number | null;
  detail: ReviewEscapeDetail;
  recordedAt: number;
  /** The head Closeout accepted after the fix, once it did. */
  fixHead: string | null;
  /** The files the fix changed, once settled. */
  files: string[] | null;
  /** True for an escape, false for not an escape, null until the fix is accepted. */
  escape: boolean | null;
  notEscapeReason: NotEscapeReason | null;
  settledAt: number | null;
};

type Row = {
  id: number;
  trigger_key: string;
  item_id: string;
  trigger: ReviewEscapeTrigger;
  accepted_head: string;
  pull_number: number | null;
  detail: string;
  recorded_at: number;
  fix_head: string | null;
  files: string | null;
  is_escape: number | null;
  not_escape_reason: NotEscapeReason | null;
  settled_at: number | null;
};

const COMMENT_CHARS = 500;

/**
 * Record a candidate review escape for a fix round that started on an accepted head, once per
 * trigger key. False when the key was already recorded. Call inside the restart's transaction.
 */
export function recordReviewEscape(
  db: Database,
  candidate: {
    triggerKey: string;
    itemId: string;
    trigger: ReviewEscapeTrigger;
    acceptedHead: string;
    pullNumber: number | null;
    detail: ReviewEscapeDetail;
    recordedAt: number;
  },
): boolean {
  const detail: ReviewEscapeDetail = {
    ...candidate.detail,
    ...(candidate.detail.comments
      ? {
          comments: candidate.detail.comments.map((comment) => ({
            ...comment,
            body: comment.body.slice(0, COMMENT_CHARS),
          })),
        }
      : {}),
  };
  return (
    db.run(
      `INSERT INTO review_escape (trigger_key, item_id, trigger, accepted_head, pull_number, detail, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(trigger_key) DO NOTHING`,
      [
        candidate.triggerKey,
        candidate.itemId,
        candidate.trigger,
        candidate.acceptedHead,
        candidate.pullNumber,
        JSON.stringify(detail),
        candidate.recordedAt,
      ],
    ).changes > 0
  );
}

/** This item's candidates whose fix Closeout has not accepted yet, oldest first. */
export function openReviewEscapes(db: Database, itemId: string): ReviewEscapeRecord[] {
  return db
    .query<Row, [string]>(
      "SELECT * FROM review_escape WHERE item_id = ? AND settled_at IS NULL ORDER BY id",
    )
    .all(itemId)
    .map(mapRow);
}

/** Settle an open candidate with the fix Closeout accepted. False when it was already settled. */
export function settleReviewEscape(
  db: Database,
  id: number,
  settled: {
    fixHead: string;
    files: readonly string[];
    escape: boolean;
    notEscapeReason: NotEscapeReason | null;
    now: number;
  },
): boolean {
  return (
    db.run(
      `UPDATE review_escape SET fix_head = ?, files = ?, is_escape = ?, not_escape_reason = ?, settled_at = ?
       WHERE id = ? AND settled_at IS NULL`,
      [
        settled.fixHead,
        JSON.stringify(settled.files),
        settled.escape ? 1 : 0,
        settled.escape ? null : settled.notEscapeReason,
        settled.now,
        id,
      ],
    ).changes > 0
  );
}

/** Every candidate recorded at or after `since`, oldest first. */
export function listReviewEscapes(db: Database, since = 0): ReviewEscapeRecord[] {
  return db
    .query<Row, [number]>("SELECT * FROM review_escape WHERE recorded_at >= ? ORDER BY id")
    .all(since)
    .map(mapRow);
}

function mapRow(row: Row): ReviewEscapeRecord {
  return {
    id: row.id,
    triggerKey: row.trigger_key,
    itemId: row.item_id,
    trigger: row.trigger,
    acceptedHead: row.accepted_head,
    pullNumber: row.pull_number,
    detail: JSON.parse(row.detail) as ReviewEscapeDetail,
    recordedAt: row.recorded_at,
    fixHead: row.fix_head,
    files: row.files === null ? null : (JSON.parse(row.files) as string[]),
    escape: row.is_escape === null ? null : row.is_escape === 1,
    notEscapeReason: row.not_escape_reason,
    settledAt: row.settled_at,
  };
}
