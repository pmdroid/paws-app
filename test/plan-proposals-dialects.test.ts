import { afterEach, expect, test } from "bun:test";
import { getPlanProposalSteps, recordPlanFiledSteps, savePlanProposalSteps } from "../src/db";
import { forEachDialect, insertWorkItem, type DialectDb } from "./dialects";

const open: DialectDb[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

const draft = {
  title: "Split the parser",
  description: "Move tokens out.",
  acceptanceCriteria: ["Tokens live in their own module"],
  blockedBy: [],
};

forEachDialect((connect) => {
  test("a plan proposal is saved, read back and filed once", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await insertWorkItem(db, "item");
    expect(await db.run((q) => getPlanProposalSteps(q, "question"))).toBeNull();
    const saved = await db.run((q) =>
      savePlanProposalSteps(q, {
        questionId: "question",
        itemId: "item",
        parentIssueId: "parent",
        repository: null,
        drafts: [draft],
        now: 10,
      }),
    );
    expect(saved).toEqual({
      questionId: "question",
      itemId: "item",
      parentIssueId: "parent",
      repository: null,
      drafts: [draft],
      createdAt: 10,
      filed: null,
      filedAt: null,
    });
    const filed = [{ id: "issue-1", identifier: "PAS-1", url: "https://linear.app/PAS-1" }];
    const first = await db.transaction((q) => recordPlanFiledSteps(q, "question", filed, 20));
    expect(first).toMatchObject({ filed, filedAt: 20 });
    const again = await db.transaction((q) => recordPlanFiledSteps(q, "question", [], 30));
    expect(again).toMatchObject({ filed, filedAt: 20 });
    await expect(db.transaction((q) => recordPlanFiledSteps(q, "missing", [], 30))).rejects.toThrow(
      "Plan proposal missing is missing",
    );
  });
});
