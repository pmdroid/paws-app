import { expect, test } from "bun:test";
import {
  getItemPullRequestSteps,
  getOpenFindingsLineSteps,
  getPublishedHeadSteps,
  recordItemPullRequestSteps,
  withOpenFindingsSteps,
  type Db,
} from "../src/db";
import { forEachDialect, insertWorkItem } from "./dialects";

forEachDialect((open) => {
  async function withDb(body: (db: Db) => Promise<void>) {
    const opened = await open();
    try {
      await insertWorkItem(opened.db, "A");
      await body(opened.db);
    } finally {
      await opened.close();
    }
  }

  const pull = { itemId: "A", pullNumber: 7, pullUrl: null, openedAt: 1 };

  test("each publication replaces the open-findings line", () =>
    withDb(async (db) => {
      expect(await db.run((q) => getPublishedHeadSteps(q, "A"))).toBeNull();
      expect(await db.run((q) => withOpenFindingsSteps(q, "A", "done"))).toBe("done");
      await db.run((q) =>
        recordItemPullRequestSteps(q, { ...pull, published: { head: "h1", line: "1 open" } }),
      );
      expect(await db.run((q) => getPublishedHeadSteps(q, "A"))).toBe("h1");
      expect(await db.run((q) => withOpenFindingsSteps(q, "A", "done"))).toBe("done\n\n1 open");
      await db.run((q) =>
        recordItemPullRequestSteps(q, { ...pull, published: { head: "h2", line: "" } }),
      );
      expect(await db.run((q) => getPublishedHeadSteps(q, "A"))).toBe("h2");
      expect(await db.run((q) => getOpenFindingsLineSteps(q, "A"))).toBeNull();
    }));

  test("recording the pull request without a publication keeps the published head", () =>
    withDb(async (db) => {
      await db.run((q) => recordItemPullRequestSteps(q, pull));
      expect(await db.run((q) => getPublishedHeadSteps(q, "A"))).toBeNull();
      await db.run((q) =>
        recordItemPullRequestSteps(q, { ...pull, published: { head: "h1", line: "1 open" } }),
      );
      await db.run((q) => recordItemPullRequestSteps(q, { ...pull, pullUrl: "u" }));
      expect(await db.run((q) => getPublishedHeadSteps(q, "A"))).toBe("h1");
      expect(await db.run((q) => getOpenFindingsLineSteps(q, "A"))).toBe("1 open");
      expect(await db.run((q) => getItemPullRequestSteps(q, "A"))).toEqual({
        ...pull,
        pullUrl: "u",
      });
    }));
});
