import { expect, test } from "bun:test";
import { getTaskMergeSettingsSteps, keepTaskMergeSettingsSteps } from "../src/db";
import { forEachDialect, insertWorkItem } from "./dialects";

forEachDialect((open) => {
  test("a task keeps the merge settings it resolved first", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "item");
      expect(await db.run((q) => getTaskMergeSettingsSteps(q, "item"))).toBeNull();
      const first = { order: "queue", mainMoved: "ci", resolved: { order: "default" } } as const;
      await db.run((q) => keepTaskMergeSettingsSteps(q, "item", first, 10));
      await db.run((q) =>
        keepTaskMergeSettingsSteps(q, "item", { ...first, order: "ci-green", resolved: {} }, 20),
      );
      expect(await db.run((q) => getTaskMergeSettingsSteps(q, "item"))).toEqual(first);
    } finally {
      await close();
    }
  });
});
