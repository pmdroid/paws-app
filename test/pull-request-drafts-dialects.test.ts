import { expect, test } from "bun:test";
import {
  getPullRequestDraftSteps,
  getPullRequestTextSteps,
  pullRequestDraftSavedAtSteps,
  savePullRequestDraftSteps,
  savePullRequestTextSteps,
} from "../src/db";
import { forEachDialect, insertWorkItem } from "./dialects";

forEachDialect((open) => {
  test("a pull request draft and text save, replace and read back", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "item");
      expect(await db.run((q) => getPullRequestDraftSteps(q, "item"))).toBeNull();
      expect(await db.run((q) => pullRequestDraftSavedAtSteps(q, "item"))).toBeNull();
      expect(await db.run((q) => getPullRequestTextSteps(q, "item"))).toBeNull();

      await db.run((q) => savePullRequestDraftSteps(q, "item", { title: "a", body: "b" }, 10));
      await db.run((q) => savePullRequestDraftSteps(q, "item", { title: "c", body: "d" }, 20));
      expect(await db.run((q) => getPullRequestDraftSteps(q, "item"))).toEqual({
        title: "c",
        body: "d",
      });
      expect(await db.run((q) => pullRequestDraftSavedAtSteps(q, "item"))).toBe(20);

      const text = { title: "t", body: "b", evidence: "e" };
      await db.run((q) => savePullRequestTextSteps(q, "item", text, 10));
      await db.run((q) => savePullRequestTextSteps(q, "item", { ...text, evidence: "f" }, 20));
      expect(await db.run((q) => getPullRequestTextSteps(q, "item"))).toEqual({
        ...text,
        evidence: "f",
      });
    } finally {
      await close();
    }
  });
});
