import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { getWorkItem, migrate, migrations } from "../src/db";
import { intakeDelegatedIssue } from "../src/intake";
import { createFakeTracker, type EpicSnapshot } from "../src/linear";
import { tempDb } from "./helpers";

for (const source of ["linear", "github"] as const) {
  test(`${source} persists full child and epic briefs and replays the original intake snapshot`, async () => {
    const db = tempDb();
    const parentId = source === "github" ? "github:acme/widgets#1" : "parent";
    const childId = source === "github" ? "github:acme/widgets#2" : "child";
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
      const item = getWorkItem(db, result.items[0]!.id)!;
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
      expect(getWorkItem(db, item.id)?.brief).toEqual(item.brief);
    } finally {
      db.close();
    }
  });
}

test("lone issues preserve body acceptance criteria without duplicating the issue as its epic", async () => {
  const db = tempDb();
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
    expect(getWorkItem(db, result.items[0]!.id)?.brief).toMatchObject({
      issue: { description: "## Acceptance criteria\nBody-only requirement" },
      epic: null,
    });
  } finally {
    db.close();
  }
});

test("the append-only brief migration upgrades existing items without inventing requirements", () => {
  const db = new Database(":memory:");
  try {
    db.run(
      "CREATE TABLE schema_migration (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT",
    );
    for (const migration of migrations.filter((entry) => entry.id !== "006_work_brief")) {
      db.run(migration.sql);
      db.run("INSERT INTO schema_migration VALUES (?, 1)", [migration.id]);
    }
    db.run(
      "INSERT INTO epic (id, linear_issue_id, linear_identifier, title, state, version, created_at) VALUES ('epic', 'parent', 'ENG-1', 'Epic', 'running', 0, 1)",
    );
    db.run(
      "INSERT INTO work_item (id, epic_id, linear_issue_id, linear_identifier, title, state, branch_name, position, version, created_at) VALUES ('item', 'epic', 'child', 'ENG-2', 'Child', 'queued', 'paws/eng-2', 0, 0, 1)",
    );
    migrate(db);
    migrate(db);
    expect(getWorkItem(db, "item")?.brief).toBeNull();
    expect(getWorkItem(db, "item")?.title).toBe("Child");
  } finally {
    db.close();
  }
});
