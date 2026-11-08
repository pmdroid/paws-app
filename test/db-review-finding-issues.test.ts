import { expect, test } from "bun:test";
import { reviewFindingKey as findingDedupeKey } from "../src/core";
import {
  claimReviewFindingIssueSteps,
  getReviewFindingIssueSteps,
  reviewFindingIssueClaimsSteps,
  reviewFindingIssuesSteps,
  reviewFindingKey,
  saveReviewFindingIssueSteps,
  type Db,
  type ReviewFindingIssue,
} from "../src/db";
import { forEachDialect, seed, withoutForeignKeys } from "./dialects";

const finding = { repository: "o/r", location: "src/a.ts:3", text: "a bug" };

function issue(key: string, identifier = "PAS-1"): ReviewFindingIssue {
  return {
    key,
    repository: "o/r",
    path: "src/a.ts",
    lines: "3",
    linearIssueId: `id-${identifier}`,
    identifier,
    url: null,
    itemId: null,
    filedBy: "someone",
    filedAt: 10,
  };
}

function claim(key: string) {
  return { key, finding, itemId: null, by: "someone", now: 10 };
}

/** A daily finding `id` whose improvement carries `sourceKey`, in review state `reviewState`. */
function seedSourcedFinding(db: Db, id: number, sourceKey: string, reviewState: string) {
  return seed(
    db,
    (q) =>
      q.orm.insert(q.t.reviewFinding).values({
        id,
        dedupeKey: findingDedupeKey(finding),
        repository: "o/r",
        path: "src/a.ts",
        lines: "3",
        severity: "P2",
        review: "correctness",
        text: "a bug",
        bugClass: "logic",
        why: "pre-existing",
        firstItemId: "A",
        firstHead: "h",
        firstSeenAt: 0,
        lastItemId: "A",
        lastHead: "h",
        lastSeenAt: 0,
      }),
    (q) =>
      q.orm.insert(q.t.improvement).values({
        id: "improvement",
        workspaceId: "w",
        repository: "o/r",
        createdAt: 0,
        reviewState,
        intent: "create",
        reviewedProposal: 1,
      }),
    (q) =>
      q.orm.insert(q.t.improvementSource).values({
        workspaceId: "w",
        sourceKind: "daily_finding",
        sourceKey,
        improvementId: "improvement",
        createdAt: 0,
      }),
  );
}

forEachDialect((open) => {
  async function withDb(body: (db: Db) => Promise<void>) {
    const opened = await open();
    try {
      await withoutForeignKeys(opened.db);
      await body(opened.db);
    } finally {
      await opened.close();
    }
  }

  const keyA = "a".repeat(64);
  const keyB = "b".repeat(64);

  test("the first filed issue for a key stays and is what save returns", () =>
    withDb(async (db) => {
      expect(await db.run((q) => getReviewFindingIssueSteps(q, keyA))).toBeNull();
      expect(await db.run((q) => saveReviewFindingIssueSteps(q, issue(keyA, "PAS-1")))).toEqual(
        issue(keyA, "PAS-1"),
      );
      expect(await db.run((q) => saveReviewFindingIssueSteps(q, issue(keyA, "PAS-2")))).toEqual(
        issue(keyA, "PAS-1"),
      );
      expect(await db.run((q) => getReviewFindingIssueSteps(q, keyA))).toEqual(
        issue(keyA, "PAS-1"),
      );
    }));

  test("filed issues come back by key, across chunks and repeated keys", () =>
    withDb(async (db) => {
      await db.run((q) => saveReviewFindingIssueSteps(q, issue(keyA)));
      await db.run((q) => saveReviewFindingIssueSteps(q, issue(keyB, "PAS-2")));
      const padding = Array.from({ length: 600 }, (_, n) => String(n).padStart(64, "0"));
      const found = await db.run((q) =>
        reviewFindingIssuesSteps(q, [...padding, keyA, keyA, keyB]),
      );
      expect([...found.keys()].sort()).toEqual([keyA, keyB]);
      expect(found.get(keyB)?.identifier).toBe("PAS-2");
      expect((await db.run((q) => reviewFindingIssuesSteps(q, []))).size).toBe(0);
    }));

  test("a claim is refused only when its finding's improvement was accepted", () =>
    withDb(async (db) => {
      await seedSourcedFinding(db, 7, "o/r#7:digest", "accepted");
      expect(await db.transaction((q) => claimReviewFindingIssueSteps(q, claim(keyA)))).toBe(false);
      const claims = await db.run((q) =>
        reviewFindingIssueClaimsSteps(q, [
          { key: findingDedupeKey(finding), ...finding, path: "src/a.ts", lines: "3" },
        ]),
      );
      expect(claims.size).toBe(0);
    }));

  test("a source key that only starts with the finding id does not refuse the claim", () =>
    withDb(async (db) => {
      await seedSourcedFinding(db, 7, "o/r#70:digest", "accepted");
      expect(await db.transaction((q) => claimReviewFindingIssueSteps(q, claim(keyA)))).toBe(true);
    }));

  test("an improvement still in review does not refuse the claim", () =>
    withDb(async (db) => {
      await seedSourcedFinding(db, 7, "o/r#7:digest", "needs_review");
      expect(await db.transaction((q) => claimReviewFindingIssueSteps(q, claim(keyA)))).toBe(true);
    }));

  test("claims report the stored issue, a claim still being filed, and nothing else", () =>
    withDb(async (db) => {
      const place = { repository: "o/r", path: "src/a.ts", lines: "3" };
      const dedupe = findingDedupeKey(finding);
      const filedKey = reviewFindingKey({ ...finding, text: "filed" })!;
      expect((await db.run((q) => reviewFindingIssueClaimsSteps(q, []))).size).toBe(0);
      await db.transaction((q) => claimReviewFindingIssueSteps(q, claim(keyA)));
      await db.run((q) => saveReviewFindingIssueSteps(q, issue(filedKey, "PAS-9")));
      const claims = await db.run((q) =>
        reviewFindingIssueClaimsSteps(q, [
          { key: dedupe, ...place, text: "a bug" },
          { key: "filed-without-claim", ...place, text: "filed" },
          { key: "never", ...place, text: "untouched" },
        ]),
      );
      expect(claims.get(dedupe)).toEqual({ findingKey: dedupe, issue: null });
      expect(claims.get("filed-without-claim")?.issue?.identifier).toBe("PAS-9");
      expect(claims.has("never")).toBe(false);
      await db.run((q) => saveReviewFindingIssueSteps(q, issue(keyA, "PAS-3")));
      const filed = await db.run((q) =>
        reviewFindingIssueClaimsSteps(q, [{ key: dedupe, ...place, text: "a bug" }]),
      );
      expect(filed.get(dedupe)?.issue?.identifier).toBe("PAS-3");
    }));
});
