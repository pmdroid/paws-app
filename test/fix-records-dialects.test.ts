import { expect, test } from "bun:test";
import { forEachDialect, insertWorkItem } from "./dialects";
import { handleFixRecordsRequest } from "../src/server/fix-records";
import { getWorkItem, listFixRecords, restart, type Db, type FixTriggers } from "../src/db";

const comment = (id: number): FixTriggers => ({
  comments: [{ id, author: "reviewer", excerpt: "Rename this helper." }],
});

async function sendBack(db: Db, reason: "review" | "ci", triggers: FixTriggers, now: number) {
  const item = (await getWorkItem(db, "item"))!;
  await restart(db, item, { reason, body: reason, now, fix: { triggers, headBefore: `h${now}` } });
}

forEachDialect((open) => {
  test("a review comment that comes back closes the round not_fixed and opens the next", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "item");
      await sendBack(db, "review", comment(7), 1);
      await sendBack(db, "ci", { checks: [{ name: "lint", url: null }] }, 2);
      await sendBack(db, "review", comment(8), 3);
      const rows = await listFixRecords(db);
      expect(rows.map((row) => [row.reason, row.round, row.outcome, row.headAfter])).toEqual([
        ["review", 1, "not_fixed", "h3"],
        ["ci", 2, null, null],
        ["review", 3, null, null],
      ]);
      expect(rows[0]!.durationMs).toBe(2);
      expect(rows[2]!.triggers).toEqual(comment(8));
    } finally {
      await close();
    }
  });

  test("the API filters fix rounds by reason and since", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "item");
      await sendBack(db, "ci", { checks: [{ name: "test", url: null }] }, 1);
      await sendBack(db, "review", comment(1), 5);
      await sendBack(db, "ci", { checks: [{ name: "lint", url: null }] }, 9);
      const read = async (query: string) => {
        const response = await handleFixRecordsRequest(
          new Request(`http://paws.test/api/fix-records${query}`),
          { store: db },
        );
        const { records } = (await response.json()) as { records: { startedAt: number }[] };
        return records.map((record) => record.startedAt);
      };
      expect(await read("")).toEqual([1, 5, 9]);
      expect(await read("?reason=ci")).toEqual([1, 9]);
      expect(await read("?since=5")).toEqual([5, 9]);
      expect(await read("?reason=ci&since=2")).toEqual([9]);
      expect(await read("?repository=acme/app")).toEqual([]);
      const bad = await handleFixRecordsRequest(
        new Request("http://paws.test/api/fix-records?reason=nope"),
        { store: db },
      );
      expect(bad.status).toBe(400);
    } finally {
      await close();
    }
  });
});
