import { expect, test } from "bun:test";
import {
  getReviewFindingByKeySteps,
  getReviewFindingSteps,
  listReviewFindingsSteps,
  markReviewFindingFiledSteps,
  recordReviewFindingsSteps,
  reviewFindingItemsSteps,
  reviewFindingsByIdsSteps,
  setReviewFindingStatusSteps,
  type Db,
  type ReviewFindingReport,
} from "../src/db";
import { forEachDialect, insertWorkItem } from "./dialects";

function finding(location: string, overrides: Partial<ReviewFindingReport> = {}) {
  return {
    review: "correctness",
    severity: "P2",
    location,
    text: `finding at ${location}`,
    bugClass: "logic",
    why: "pre-existing",
    ...overrides,
  } satisfies ReviewFindingReport;
}

forEachDialect((open) => {
  async function withDb(body: (db: Db) => Promise<void>) {
    const opened = await open();
    try {
      await insertWorkItem(opened.db, "A");
      await insertWorkItem(opened.db, "B");
      await body(opened.db);
    } finally {
      await opened.close();
    }
  }

  const record = (
    db: Db,
    itemId: string,
    head: string,
    seenAt: number,
    findings: ReviewFindingReport[],
    reviewed: { review: string; paths: string[] }[] = [],
  ) =>
    db.transaction((q) =>
      recordReviewFindingsSteps(q, { itemId, repository: "o/r", head, seenAt, findings, reviewed }),
    );

  test("findings are recorded once per key, counted per item and gone when no longer reported", () =>
    withDb(async (db) => {
      expect(
        await record(db, "A", "h1", 10, [finding("src/a.ts:3"), finding("src/a.ts:3")]),
      ).toEqual({ recorded: 1, gone: 0 });
      await record(db, "B", "h2", 20, [finding("src/a.ts:3", { severity: "P1" })]);
      await record(db, "A", "h0", 5, [finding("src/a.ts:3")]);
      const [one] = await db.run((q) => listReviewFindingsSteps(q));
      expect(one).toMatchObject({
        path: "src/a.ts",
        lines: "3",
        severity: "P1",
        itemCount: 2,
        status: "open",
        statusBy: null,
        filedIssue: null,
        first: { itemId: "A", head: "h0", at: 5 },
        last: { itemId: "B", head: "h2", at: 20 },
      });
      expect(await db.run((q) => getReviewFindingSteps(q, one!.id))).toEqual(one!);
      expect(await db.run((q) => getReviewFindingByKeySteps(q, one!.key))).toEqual(one!);
      expect(await db.run((q) => getReviewFindingSteps(q, 999))).toBeNull();

      expect(
        await record(
          db,
          "A",
          "h3",
          30,
          [finding("src/b.ts:1")],
          [{ review: "correctness", paths: ["src/a.ts:9"] }],
        ),
      ).toEqual({ recorded: 1, gone: 1 });
      expect((await db.run((q) => getReviewFindingSteps(q, one!.id)))?.status).toBe("gone");
      await record(db, "B", "h4", 40, [finding("src/a.ts:3")]);
      expect(await db.run((q) => getReviewFindingSteps(q, one!.id))).toMatchObject({
        status: "open",
        statusAt: 40,
        statusReason: "A later accepted review reported it again.",
      });

      const items = await db.run((q) => reviewFindingItemsSteps(q, [one!.id]));
      expect(items.get(one!.id)).toEqual([
        {
          findingId: one!.id,
          itemId: "B",
          identifier: "B",
          title: "B",
          sessionKey: null,
          head: "h4",
          seenAt: 40,
        },
        {
          findingId: one!.id,
          itemId: "A",
          identifier: "A",
          title: "A",
          sessionKey: null,
          head: "h1",
          seenAt: 10,
        },
      ]);
      expect((await db.run((q) => reviewFindingItemsSteps(q, []))).size).toBe(0);
    }));

  test("findings filter by item, head, field and path prefix, newest first", () =>
    withDb(async (db) => {
      await record(db, "A", "h1", 10, [
        finding("src/a.ts:1"),
        finding("lib/b.ts:2", { severity: "P0" }),
      ]);
      await record(db, "B", "h2", 20, [finding("src/c.ts:3", { review: "security" })]);
      const paths = async (filter: Parameters<typeof listReviewFindingsSteps>[1]) =>
        (await db.run((q) => listReviewFindingsSteps(q, filter))).map((f) => f.path);
      expect(await paths({})).toEqual(["src/c.ts", "lib/b.ts", "src/a.ts"]);
      expect(await paths({ itemId: "A" })).toEqual(["lib/b.ts", "src/a.ts"]);
      expect(await paths({ itemId: "A", head: "h2" })).toEqual([]);
      expect(await paths({ head: "h2" })).toEqual(["src/c.ts"]);
      expect(await paths({ severity: "P0" })).toEqual(["lib/b.ts"]);
      expect(await paths({ review: "security", repository: "o/r" })).toEqual(["src/c.ts"]);
      expect(await paths({ pathPrefix: "src/" })).toEqual(["src/c.ts", "src/a.ts"]);
      expect(await paths({ status: "dismissed" })).toEqual([]);
      const all = await db.run((q) => listReviewFindingsSteps(q));
      const ids = all.map((f) => f.id);
      expect((await db.run((q) => reviewFindingsByIdsSteps(q, ids))).map((f) => f.id)).toEqual(
        [...ids].sort((a, b) => a - b),
      );
      expect(await db.run((q) => reviewFindingsByIdsSteps(q, []))).toEqual([]);
    }));

  test("a member dismisses, reopens and files a finding", () =>
    withDb(async (db) => {
      await record(db, "A", "h1", 10, [finding("src/a.ts:1")]);
      const [{ id, key }] = (await db.run((q) => listReviewFindingsSteps(q))) as [
        { id: number; key: string },
      ];
      const reopen = { id, status: "open", by: "u", now: 11 } as const;
      expect(await db.run((q) => setReviewFindingStatusSteps(q, reopen))).toBeNull();
      expect(
        await db.run((q) =>
          setReviewFindingStatusSteps(q, {
            id,
            status: "dismissed",
            reason: "noise",
            by: "u",
            now: 12,
          }),
        ),
      ).toMatchObject({ status: "dismissed", statusBy: "u", statusAt: 12, statusReason: "noise" });
      expect(await db.run((q) => setReviewFindingStatusSteps(q, reopen))).toMatchObject({
        status: "open",
        statusReason: null,
      });
      const filing = { key, issue: "PAS-1", by: null, now: 13 };
      expect(await db.run((q) => markReviewFindingFiledSteps(q, filing))).toMatchObject({
        status: "filed",
        filedIssue: "PAS-1",
        statusBy: null,
        statusAt: 13,
      });
      expect(
        await db.run((q) => markReviewFindingFiledSteps(q, { ...filing, key: "missing" })),
      ).toBeNull();
    }));
});
