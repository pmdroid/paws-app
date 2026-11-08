import type { Database } from "bun:sqlite";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { reviewFindingKey as coreFindingKey } from "../core";
import { settled, sqliteDb, type Q, type Steps } from "./db";

/** Where a finding points: its path and its line, or `first-last`. */
export type ReviewFindingPlace = { path: string; lines: string };

/** The Linear issue filed from a pre-existing review finding. */
export type ReviewFindingIssue = Q["t"]["reviewFindingIssue"]["$inferSelect"];

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

export function* getReviewFindingIssueSteps(q: Q, key: string): Steps<ReviewFindingIssue | null> {
  const { reviewFindingIssue } = q.t;
  return (
    (yield* q.one(
      q.orm.select().from(reviewFindingIssue).where(eq(reviewFindingIssue.key, key)),
    )) ?? null
  );
}

export function getReviewFindingIssue(db: Database, key: string): ReviewFindingIssue | null {
  return settled(sqliteDb(db).run((q) => getReviewFindingIssueSteps(q, key)));
}

/** The filed issues of `keys`, by key. */
export function* reviewFindingIssuesSteps(
  q: Q,
  keys: readonly string[],
): Steps<Map<string, ReviewFindingIssue>> {
  const { reviewFindingIssue } = q.t;
  const unique = [...new Set(keys)];
  const found = new Map<string, ReviewFindingIssue>();
  for (let start = 0; start < unique.length; start += 500) {
    const chunk = unique.slice(start, start + 500);
    const rows = yield* q.all(
      q.orm.select().from(reviewFindingIssue).where(inArray(reviewFindingIssue.key, chunk)),
    );
    for (const row of rows) found.set(row.key, row);
  }
  return found;
}

export function reviewFindingIssues(
  db: Database,
  keys: readonly string[],
): Map<string, ReviewFindingIssue> {
  return settled(sqliteDb(db).run((q) => reviewFindingIssuesSteps(q, keys)));
}

/** Stores the filed issue unless one is already stored for its key; returns the stored one. */
export function* saveReviewFindingIssueSteps(
  q: Q,
  issue: ReviewFindingIssue,
): Steps<ReviewFindingIssue> {
  const { reviewFindingIssue } = q.t;
  yield* q.exec(
    q.orm
      .insert(reviewFindingIssue)
      .values(issue)
      .onConflictDoNothing({ target: reviewFindingIssue.key }),
  );
  return (yield* getReviewFindingIssueSteps(q, issue.key))!;
}

export function saveReviewFindingIssue(
  db: Database,
  issue: ReviewFindingIssue,
): ReviewFindingIssue {
  return settled(sqliteDb(db).run((q) => saveReviewFindingIssueSteps(q, issue)));
}

type ReviewFindingIssueClaimInput = {
  key: string;
  finding: { repository: string; location: string; text: string };
  itemId: string | null;
  by: string;
  now: number;
};

/** Run inside a transaction: the accepted check and the claim are one step. */
export function* claimReviewFindingIssueSteps(
  q: Q,
  input: ReviewFindingIssueClaimInput,
): Steps<boolean> {
  const { improvement, improvementSource, reviewFinding, reviewFindingIssueClaim } = q.t;
  const findingKey = coreFindingKey(input.finding);
  const accepted = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(reviewFinding)
      .innerJoin(
        improvementSource,
        and(
          eq(improvementSource.sourceKind, "daily_finding"),
          sql`${improvementSource.sourceKey} LIKE '%#' || ${reviewFinding.id} || ':%'`,
        ),
      )
      .innerJoin(improvement, eq(improvement.id, improvementSource.improvementId))
      .where(and(eq(reviewFinding.dedupeKey, findingKey), eq(improvement.reviewState, "accepted")))
      .limit(1),
  );
  if (accepted !== undefined) return false;
  yield* q.exec(
    q.orm
      .insert(reviewFindingIssueClaim)
      .values({
        key: input.key,
        findingKey,
        itemId: input.itemId,
        claimedBy: input.by,
        claimedAt: input.now,
      })
      .onConflictDoNothing({ target: reviewFindingIssueClaim.key }),
  );
  return true;
}

export function claimReviewFindingIssue(
  db: Database,
  input: ReviewFindingIssueClaimInput,
): boolean {
  return settled(sqliteDb(db).transaction((q) => claimReviewFindingIssueSteps(q, input)));
}

export type ReviewFindingIssueClaim = { findingKey: string; issue: ReviewFindingIssue | null };

type ClaimedFinding = {
  key: string;
  repository: string;
  path: string;
  lines: string;
  text: string;
};

export function* reviewFindingIssueClaimsSteps(
  q: Q,
  findings: readonly ClaimedFinding[],
): Steps<Map<string, ReviewFindingIssueClaim>> {
  const { reviewFindingIssueClaim } = q.t;
  const claims = new Map<string, ReviewFindingIssueClaim>();
  if (findings.length === 0) return claims;
  const keys = [...new Set(findings.map((finding) => finding.key))];
  const byFinding = new Map<string, string>();
  for (let start = 0; start < keys.length; start += 500) {
    const rows = yield* q.all(
      q.orm
        .select({
          findingKey: reviewFindingIssueClaim.findingKey,
          key: reviewFindingIssueClaim.key,
        })
        .from(reviewFindingIssueClaim)
        .where(inArray(reviewFindingIssueClaim.findingKey, keys.slice(start, start + 500)))
        .orderBy(reviewFindingIssueClaim.claimedAt, reviewFindingIssueClaim.key),
    );
    for (const row of rows) byFinding.set(row.findingKey, row.key);
  }
  for (const finding of findings) {
    const issueKey =
      byFinding.get(finding.key) ??
      reviewFindingKey({
        repository: finding.repository,
        location: `${finding.path}:${finding.lines}`,
        text: finding.text,
      });
    const issue = issueKey === null ? null : yield* getReviewFindingIssueSteps(q, issueKey);
    if (byFinding.has(finding.key) || issue !== null)
      claims.set(finding.key, { findingKey: finding.key, issue });
  }
  return claims;
}

export function reviewFindingIssueClaims(
  db: Database,
  findings: readonly ClaimedFinding[],
): Map<string, ReviewFindingIssueClaim> {
  return settled(sqliteDb(db).run((q) => reviewFindingIssueClaimsSteps(q, findings)));
}
