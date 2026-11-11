import type { Database } from "bun:sqlite";
import { and, desc, eq, inArray, lt, lte, notInArray, sql, type SQL } from "drizzle-orm";
import { findingPlace, reviewFindingKey, type ReviewFindingStatus } from "../core";
import { settled, sqliteDb, type Q, type Steps, type Db } from "./db";

export type ReviewFindingSeverity = "P0" | "P1" | "P2" | "P3";
/** In code the change did not touch, or reported only because it is below the review's `failOn`. */
export type ReviewFindingWhy = "pre-existing" | "below failOn" | "meets failOn";

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

type Row = Q["t"]["reviewFinding"]["$inferSelect"];

type RecordReviewFindings = {
  itemId: string;
  /** `owner/repo`. */
  repository: string;
  head: string;
  seenAt: number;
  findings: readonly ReviewFindingReport[];
  reviewed: readonly { review: string; paths: readonly string[] }[];
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
export function* recordReviewFindingsSteps(
  q: Q,
  input: RecordReviewFindings,
): Steps<{ recorded: number; gone: number }> {
  const { reviewFinding } = q.t;
  const keys = new Set<string>();
  for (const finding of input.findings) {
    const key = reviewFindingKey({
      repository: input.repository,
      location: finding.location,
      text: finding.text,
    });
    if (keys.has(key)) continue;
    keys.add(key);
    yield* upsert(q, input, finding, key);
  }
  let gone = 0;
  for (const review of input.reviewed) {
    const paths = [...new Set(review.paths.map((path) => findingPlace(path).path))];
    if (paths.length === 0) continue;
    const changed = yield* q.all(
      q.orm
        .update(reviewFinding)
        .set({
          status: "gone",
          statusBy: null,
          statusAt: input.seenAt,
          statusReason: "A later accepted review of this path no longer reported it.",
        })
        .where(
          and(
            eq(reviewFinding.status, "open"),
            eq(reviewFinding.repository, input.repository),
            eq(reviewFinding.review, review.review),
            lt(reviewFinding.lastSeenAt, input.seenAt),
            inArray(reviewFinding.path, paths),
            notInArray(reviewFinding.dedupeKey, [...keys]),
          ),
        )
        .returning({ id: reviewFinding.id }),
    );
    gone += changed.length;
  }
  return { recorded: keys.size, gone };
}

export function recordReviewFindings(
  db: Database,
  input: RecordReviewFindings,
): { recorded: number; gone: number } {
  return settled(sqliteDb(db).transaction((q) => recordReviewFindingsSteps(q, input)));
}

function* upsert(
  q: Q,
  input: { itemId: string; repository: string; head: string; seenAt: number },
  finding: ReviewFindingReport,
  key: string,
): Steps<void> {
  const { reviewFinding } = q.t;
  const place = findingPlace(finding.location);
  const existing = yield* q.one(
    q.orm
      .select({
        id: reviewFinding.id,
        firstSeenAt: reviewFinding.firstSeenAt,
        lastSeenAt: reviewFinding.lastSeenAt,
        status: reviewFinding.status,
      })
      .from(reviewFinding)
      .where(eq(reviewFinding.dedupeKey, key)),
  );
  if (existing === undefined) {
    const row = yield* q.one(
      q.orm
        .insert(reviewFinding)
        .values({
          dedupeKey: key,
          repository: input.repository,
          path: place.path,
          lines: place.lines,
          firstLine: place.firstLine,
          severity: finding.severity,
          review: finding.review,
          text: finding.text,
          bugClass: finding.bugClass,
          why: finding.why,
          firstItemId: input.itemId,
          firstHead: input.head,
          firstSeenAt: input.seenAt,
          lastItemId: input.itemId,
          lastHead: input.head,
          lastSeenAt: input.seenAt,
        })
        .returning({ id: reviewFinding.id }),
    );
    yield* linkItem(q, row!.id, input);
    return;
  }
  const byId = eq(reviewFinding.id, existing.id);
  if (input.seenAt >= existing.lastSeenAt)
    yield* q.exec(
      q.orm
        .update(reviewFinding)
        .set({
          severity: finding.severity,
          review: finding.review,
          text: finding.text,
          bugClass: finding.bugClass,
          why: finding.why,
          lastItemId: input.itemId,
          lastHead: input.head,
          lastSeenAt: input.seenAt,
        })
        .where(byId),
    );
  if (input.seenAt < existing.firstSeenAt)
    yield* q.exec(
      q.orm
        .update(reviewFinding)
        .set({ firstItemId: input.itemId, firstHead: input.head, firstSeenAt: input.seenAt })
        .where(byId),
    );
  if (existing.status === "gone" && input.seenAt > existing.lastSeenAt)
    yield* q.exec(
      q.orm
        .update(reviewFinding)
        .set({
          status: "open",
          statusBy: null,
          statusAt: input.seenAt,
          statusReason: "A later accepted review reported it again.",
        })
        .where(byId),
    );
  if (yield* linkItem(q, existing.id, input))
    yield* q.exec(
      q.orm
        .update(reviewFinding)
        .set({ itemCount: sql`${reviewFinding.itemCount} + 1` })
        .where(byId),
    );
}

/** Links the item to the finding; true when the item had not reported it before. */
function* linkItem(
  q: Q,
  findingId: number,
  input: { itemId: string; head: string; seenAt: number },
): Steps<boolean> {
  const { reviewFindingItem } = q.t;
  const inserted = yield* q.all(
    q.orm
      .insert(reviewFindingItem)
      .values({ findingId, itemId: input.itemId, headSha: input.head, seenAt: input.seenAt })
      .onConflictDoNothing()
      .returning({ findingId: reviewFindingItem.findingId }),
  );
  if (inserted.length > 0) return true;
  yield* q.exec(
    q.orm
      .update(reviewFindingItem)
      .set({ headSha: input.head, seenAt: input.seenAt })
      .where(
        and(
          eq(reviewFindingItem.findingId, findingId),
          eq(reviewFindingItem.itemId, input.itemId),
          lte(reviewFindingItem.seenAt, input.seenAt),
        ),
      ),
  );
  return false;
}

/** The findings that match `filter`, newest last seen first. */
export function* listReviewFindingsSteps(
  q: Q,
  filter: ReviewFindingFilter = {},
): Steps<ReviewFindingRecord[]> {
  const { reviewFinding, reviewFindingItem } = q.t;
  const where: (SQL | undefined)[] = [];
  if (filter.itemId || filter.head)
    where.push(
      inArray(
        reviewFinding.id,
        q.orm
          .select({ id: reviewFindingItem.findingId })
          .from(reviewFindingItem)
          .where(
            and(
              filter.itemId ? eq(reviewFindingItem.itemId, filter.itemId) : undefined,
              filter.head ? eq(reviewFindingItem.headSha, filter.head) : undefined,
            ),
          ),
      ),
    );
  if (filter.repository) where.push(eq(reviewFinding.repository, filter.repository));
  if (filter.severity) where.push(eq(reviewFinding.severity, filter.severity));
  if (filter.review) where.push(eq(reviewFinding.review, filter.review));
  if (filter.status) where.push(eq(reviewFinding.status, filter.status));
  if (filter.pathPrefix)
    where.push(
      sql`substr(${reviewFinding.path}, 1, ${[...filter.pathPrefix].length}) = ${filter.pathPrefix}`,
    );
  const rows = yield* q.all(
    q.orm
      .select()
      .from(reviewFinding)
      .where(and(...where))
      .orderBy(desc(reviewFinding.lastSeenAt), desc(reviewFinding.id)),
  );
  return rows.map(mapRow);
}

export function listReviewFindings(
  db: Database,
  filter: ReviewFindingFilter = {},
): ReviewFindingRecord[] {
  return settled(sqliteDb(db).run((q) => listReviewFindingsSteps(q, filter)));
}

export function* getReviewFindingSteps(q: Q, id: number): Steps<ReviewFindingRecord | null> {
  const { reviewFinding } = q.t;
  const row = yield* q.one(q.orm.select().from(reviewFinding).where(eq(reviewFinding.id, id)));
  return row === undefined ? null : mapRow(row);
}

/** The finding with `reviewFindingKey` `key`, as filing an issue from it finds it. */
export function* getReviewFindingByKeySteps(q: Q, key: string): Steps<ReviewFindingRecord | null> {
  const { reviewFinding } = q.t;
  const row = yield* q.one(
    q.orm.select().from(reviewFinding).where(eq(reviewFinding.dedupeKey, key)),
  );
  return row === undefined ? null : mapRow(row);
}

/** The items that reported each finding in `ids`, latest first. */
export function* reviewFindingItemsSteps(
  q: Q,
  ids: readonly number[],
): Steps<Map<number, ReviewFindingItem[]>> {
  const { reviewFindingItem, workItem } = q.t;
  const byFinding = new Map<number, ReviewFindingItem[]>();
  if (ids.length === 0) return byFinding;
  const rows = yield* q.all(
    q.orm
      .select({
        findingId: reviewFindingItem.findingId,
        itemId: reviewFindingItem.itemId,
        identifier: workItem.linearIdentifier,
        title: workItem.title,
        sessionKey: workItem.sessionKey,
        head: reviewFindingItem.headSha,
        seenAt: reviewFindingItem.seenAt,
      })
      .from(reviewFindingItem)
      .innerJoin(workItem, eq(workItem.id, reviewFindingItem.itemId))
      .where(inArray(reviewFindingItem.findingId, [...ids]))
      .orderBy(desc(reviewFindingItem.seenAt), reviewFindingItem.itemId),
  );
  for (const row of rows) {
    const list = byFinding.get(row.findingId) ?? [];
    list.push(row);
    byFinding.set(row.findingId, list);
  }
  return byFinding;
}

export async function reviewFindingItems(
  store: Db,
  ids: readonly number[],
): Promise<Map<number, ReviewFindingItem[]>> {
  return store.run((q) => reviewFindingItemsSteps(q, ids));
}

type ReviewFindingStatusChange =
  | { id: number; status: "dismissed"; reason: string; by: string; now: number }
  | { id: number; status: "open"; by: string; now: number };

/**
 * A member dismisses a finding with a reason, or reopens a dismissed one. Null when the finding
 * does not exist or is not in a state that change applies to: only an open or gone finding is
 * dismissed, and only a dismissed one reopens.
 */
export function* setReviewFindingStatusSteps(
  q: Q,
  input: ReviewFindingStatusChange,
): Steps<ReviewFindingRecord | null> {
  const { reviewFinding } = q.t;
  const from = input.status === "dismissed" ? ["open", "gone"] : ["dismissed"];
  const changed = yield* q.all(
    q.orm
      .update(reviewFinding)
      .set({
        status: input.status,
        statusBy: input.by,
        statusAt: input.now,
        statusReason: input.status === "dismissed" ? input.reason : null,
      })
      .where(and(eq(reviewFinding.id, input.id), inArray(reviewFinding.status, from)))
      .returning({ id: reviewFinding.id }),
  );
  return changed.length > 0 ? yield* getReviewFindingSteps(q, input.id) : null;
}

export async function setReviewFindingStatus(
  store: Db,
  input: ReviewFindingStatusChange,
): Promise<ReviewFindingRecord | null> {
  return store.run((q) => setReviewFindingStatusSteps(q, input));
}

type ReviewFindingFiling = { key: string; issue: string; by: string | null; now: number };

/**
 * Marks the finding with `reviewFindingKey` `key` filed as the Linear issue `issue`. Filing an
 * issue from the Findings page calls it. Null when no finding has that key.
 */
export function* markReviewFindingFiledSteps(
  q: Q,
  input: ReviewFindingFiling,
): Steps<ReviewFindingRecord | null> {
  const { reviewFinding } = q.t;
  const changed = yield* q.all(
    q.orm
      .update(reviewFinding)
      .set({
        status: "filed",
        filedIssue: input.issue,
        statusBy: input.by,
        statusAt: input.now,
        statusReason: null,
      })
      .where(eq(reviewFinding.dedupeKey, input.key))
      .returning({ id: reviewFinding.id }),
  );
  return changed.length > 0 ? yield* getReviewFindingByKeySteps(q, input.key) : null;
}

export async function markReviewFindingFiled(
  store: Db,
  input: ReviewFindingFiling,
): Promise<ReviewFindingRecord | null> {
  return store.run((q) => markReviewFindingFiledSteps(q, input));
}

function mapRow(row: Row): ReviewFindingRecord {
  return {
    id: row.id,
    key: row.dedupeKey,
    repository: row.repository,
    path: row.path,
    lines: row.lines,
    severity: row.severity as ReviewFindingSeverity,
    review: row.review,
    text: row.text,
    bugClass: row.bugClass,
    why: row.why as ReviewFindingWhy,
    first: { itemId: row.firstItemId, head: row.firstHead, at: row.firstSeenAt },
    last: { itemId: row.lastItemId, head: row.lastHead, at: row.lastSeenAt },
    itemCount: row.itemCount,
    status: row.status as ReviewFindingStatus,
    statusBy: row.statusBy,
    statusAt: row.statusAt,
    statusReason: row.statusReason,
    filedIssue: row.filedIssue,
  };
}

/** Read a bounded member set without scanning the global findings table. */
export function* reviewFindingsByIdsSteps(
  q: Q,
  ids: readonly number[],
): Steps<ReviewFindingRecord[]> {
  const { reviewFinding } = q.t;
  if (!ids.length) return [];
  const rows = yield* q.all(
    q.orm
      .select()
      .from(reviewFinding)
      .where(inArray(reviewFinding.id, [...ids]))
      .orderBy(reviewFinding.id),
  );
  return rows.map(mapRow);
}

export function reviewFindingsByIds(db: Database, ids: readonly number[]): ReviewFindingRecord[] {
  return settled(sqliteDb(db).run((q) => reviewFindingsByIdsSteps(q, ids)));
}
