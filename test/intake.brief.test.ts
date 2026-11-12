import { expect, test } from "bun:test";
import { getWorkItem } from "../src/db";
import { intakeDelegatedIssue } from "../src/intake";
import { createFakeTracker, type EpicSnapshot } from "../src/linear";
import { tempStore } from "./pglite";

{
  const source = "linear";
  test(`${source} persists full child and epic briefs and replays the original intake snapshot`, async () => {
    const { db, close } = await tempStore();
    const parentId = "parent";
    const childId = "child";
    const snapshot: EpicSnapshot = {
      linearIssueId: parentId,
      identifier: "EPIC-1",
      title: "Epic",
      description: "Parent context\n\n## Acceptance criteria\nPreserve every row.\n",
      acceptanceCriteria: "Explicit epic criterion",
      subIssues: [
        {
          linearIssueId: childId,
          identifier: "CHILD-2",
          title: "Child",
          description: "Full body\n雪\n\n## Acceptance criteria\nBODY_ONLY_37\n",
          acceptanceCriteria: "Explicit child criterion",
        },
      ],
    };
    const tracker = createFakeTracker([snapshot]);
    try {
      const result = await intakeDelegatedIssue(db, tracker, { linearIssueId: parentId });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const item = (await getWorkItem(db, result.items[0]!.id))!;
      expect(item.brief).toEqual({
        issue: {
          source,
          issueId: childId,
          identifier: "CHILD-2",
          title: "Child",
          description: snapshot.subIssues[0]!.description ?? null,
          acceptanceCriteria: "Explicit child criterion",
        },
        epic: {
          source,
          issueId: parentId,
          identifier: "EPIC-1",
          title: "Epic",
          description: snapshot.description,
          acceptanceCriteria: "Explicit epic criterion",
        },
      });
      tracker.epics.clear();
      const replay = await intakeDelegatedIssue(db, tracker, { linearIssueId: parentId });
      expect(replay.ok && replay.alreadyExisted).toBe(true);
      expect((await getWorkItem(db, item.id))?.brief).toEqual(item.brief);
    } finally {
      await close();
    }
  });
}

test("lone issues preserve body acceptance criteria without duplicating the issue as its epic", async () => {
  const { db, close } = await tempStore();
  try {
    const tracker = createFakeTracker([
      {
        linearIssueId: "only",
        identifier: "ENG-1",
        title: "Only",
        description: "## Acceptance criteria\nBody-only requirement",
        subIssues: [],
      },
    ]);
    const result = await intakeDelegatedIssue(db, tracker, { linearIssueId: "only" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((await getWorkItem(db, result.items[0]!.id))?.brief).toMatchObject({
      issue: { description: "## Acceptance criteria\nBody-only requirement" },
      epic: null,
    });
  } finally {
    await close();
  }
});
