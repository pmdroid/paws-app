import { expect, test } from "bun:test";
import {
  getTaskLinearReadSteps,
  keepTaskLinearReadSteps,
  linearActivitiesListedAtSteps,
  markLinearActivitiesListedSteps,
} from "../src/db";
import { forEachDialect, insertWorkItem } from "./dialects";

forEachDialect((open) => {
  test("a task's Linear read keeps its latest value, parsed", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "item");
      const read = () => db.run((q) => getTaskLinearReadSteps(q, "item", "project_overview"));
      expect(await read()).toBeUndefined();
      await db.run((q) =>
        keepTaskLinearReadSteps(q, "item", "project_overview", { text: "a", n: [1] }, 1),
      );
      await db.run((q) => keepTaskLinearReadSteps(q, "item", "project_overview", "later", 2));
      expect(await read()).toBe("later");
      await db.run((q) => keepTaskLinearReadSteps(q, "item", "repository_hints", null, 3));
      expect(await db.run((q) => getTaskLinearReadSteps(q, "item", "repository_hints"))).toBeNull();
    } finally {
      await close();
    }
  });

  test("a session's activity listing keeps its latest generation", async () => {
    const { db, close } = await open();
    try {
      expect(await db.run((q) => linearActivitiesListedAtSteps(q, "session"))).toBeNull();
      await db.run((q) => markLinearActivitiesListedSteps(q, "session", 1));
      await db.run((q) => markLinearActivitiesListedSteps(q, "session", 3));
      expect(await db.run((q) => linearActivitiesListedAtSteps(q, "session"))).toBe(3);
    } finally {
      await close();
    }
  });
});
