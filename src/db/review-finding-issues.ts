import type { Database } from "bun:sqlite";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { reviewFindingKey as coreFindingKey } from "../core";
import { orm } from "./orm";
import {
  improvement,
  improvementSource,
  reviewFinding,
  reviewFindingIssue,
  reviewFindingIssueClaim,
} from "./schema";
import { immediate } from "./tx";

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

export function getReviewFindingIssue(db: Database, key: string): ReviewFindingIssue | null {
  return (
    orm(db).select().from(reviewFindingIssue).where(eq(reviewFindingIssue.key, key)).get() ?? null
  );
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
    const rows = orm(db)
      .select()
      .from(reviewFindingIssue)
      .where(inArray(reviewFindingIssue.key, chunk))
      .all();
    for (const row of rows) found.set(row.key, row);
  }
  return found;
}

/** Stores the filed issue unless one is already stored for its key; returns the stored one. */
export function saveReviewFindingIssue(
  db: Database,
  issue: ReviewFindingIssue,
): ReviewFindingIssue {
  orm(db)
    .insert(reviewFindingIssue)
    .values(issue)
    .onConflictDoNothing({ target: reviewFindingIssue.key })
    .run();
  return getReviewFindingIssue(db, issue.key)!;
}

export function claimReviewFindingIssue(
  db: Database,
  input: {
    key: string;
    finding: { repository: string; location: string; text: string };
    itemId: string | null;
    by: string;
    now: number;
  },
): boolean {
  const findingKey = coreFindingKey(input.finding);
  return immediate(db, () => {
    const accepted = orm(db)
      .select({ one: sql`1` })
      .from(reviewFinding)
      .innerJoin(
        improvementSource,
        and(
          eq(improvementSource.sourceKind, "daily_finding"),
          sql`instr(${improvementSource.sourceKey}, '#' || ${reviewFinding.id} || ':') > 0`,
        ),
      )
      .innerJoin(improvement, eq(improvement.id, improvementSource.improvementId))
      .where(and(eq(reviewFinding.dedupeKey, findingKey), eq(improvement.reviewState, "accepted")))
      .limit(1)
      .get();
    if (accepted !== undefined) return false;
    orm(db)
      .insert(reviewFindingIssueClaim)
      .values({
        key: input.key,
        findingKey,
        itemId: input.itemId,
        claimedBy: input.by,
        claimedAt: input.now,
      })
      .onConflictDoNothing({ target: reviewFindingIssueClaim.key })
      .run();
    return true;
  });
}

export type ReviewFindingIssueClaim = { findingKey: string; issue: ReviewFindingIssue | null };

export function reviewFindingIssueClaims(
  db: Database,
  findings: readonly {
    key: string;
    repository: string;
    path: string;
    lines: string;
    text: string;
  }[],
): Map<string, ReviewFindingIssueClaim> {
  const claims = new Map<string, ReviewFindingIssueClaim>();
  if (findings.length === 0) return claims;
  const rows = orm(db)
    .select({ findingKey: reviewFindingIssueClaim.findingKey, key: reviewFindingIssueClaim.key })
    .from(reviewFindingIssueClaim)
    .where(
      sql`${reviewFindingIssueClaim.findingKey} IN (SELECT value FROM json_each(${JSON.stringify(findings.map((f) => f.key))}))`,
    )
    .all();
  const byFinding = new Map(rows.map((row) => [row.findingKey, row.key]));
  for (const finding of findings) {
    const issueKey =
      byFinding.get(finding.key) ??
      reviewFindingKey({
        repository: finding.repository,
        location: `${finding.path}:${finding.lines}`,
        text: finding.text,
      });
    const issue = issueKey === null ? null : getReviewFindingIssue(db, issueKey);
    if (byFinding.has(finding.key) || issue !== null)
      claims.set(finding.key, { findingKey: finding.key, issue });
  }
  return claims;
}
