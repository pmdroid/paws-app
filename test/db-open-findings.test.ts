import { expect, test } from "bun:test";
import {
  getOpenFindingsLineSteps,
  getPublishedHeadSteps,
  saveOpenFindingsSteps,
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

  test("each publication replaces the open-findings line", () =>
    withDb(async (db) => {
      expect(await db.run((q) => getPublishedHeadSteps(q, "A"))).toBeNull();
      expect(await db.run((q) => withOpenFindingsSteps(q, "A", "done"))).toBe("done");
      await db.run((q) =>
        saveOpenFindingsSteps(q, { itemId: "A", head: "h1", line: "1 open", now: 1 }),
      );
      expect(await db.run((q) => getPublishedHeadSteps(q, "A"))).toBe("h1");
      expect(await db.run((q) => withOpenFindingsSteps(q, "A", "done"))).toBe("done\n\n1 open");
      await db.run((q) => saveOpenFindingsSteps(q, { itemId: "A", head: "h2", line: "", now: 2 }));
      expect(await db.run((q) => getPublishedHeadSteps(q, "A"))).toBe("h2");
      expect(await db.run((q) => getOpenFindingsLineSteps(q, "A"))).toBeNull();
    }));
});
