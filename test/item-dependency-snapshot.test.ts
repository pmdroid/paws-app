import { expect, test } from "bun:test";
import { insertQueuedItem, type Db } from "../src/db";
import { delegationSnapshotsComplete, readExternalBlockerEvidence } from "../src/intake";
import { jsonValue, seed } from "./dialects";
import { tempStore } from "./pglite";

function item(db: Db, id: string, delegationId: string, state: string, position: number) {
  return seed(db, (q) =>
    q.orm.insert(q.t.workItem).values({
      id,
      delegationId,
      linearIssueId: id,
      linearIdentifier: `DEP-${position + 2}`,
      title: id,
      state,
      branchName: `paws/${id}`,
      position,
      createdAt: 1,
    }),
  );
}

function workspace(db: Db) {
  return seed(db, (q) =>
    q.orm
      .insert(q.t.workspace)
      .values({ id: "workspace", linearOrganizationId: "org", name: "Workspace", createdAt: 1 }),
  );
}

function snapshot(db: Db, itemId: string, generation = 1, evidence?: object) {
  return seed(db, (q) =>
    q.orm.insert(q.t.itemDependencySnapshot).values({
      itemId,
      workspaceId: "workspace",
      generation,
      scope: jsonValue(q, []),
      linearStates: jsonValue(q, []),
      ...(evidence === undefined ? {} : { externalEvidence: jsonValue(q, evidence) }),
    }),
  );
}

test("a delegation is snapshot-ready only when every active item has a snapshot", async () => {
  const { db, close } = await tempStore();
  try {
    const first = await insertQueuedItem(db, { id: "first", now: 1 });
    await item(db, "second", first.delegationId, "queued", 1);
    await item(db, "done", first.delegationId, "merged", 2);
    await workspace(db);
    expect(await delegationSnapshotsComplete(db, first.delegationId)).toBe(false);
    await snapshot(db, "first");
    expect(await delegationSnapshotsComplete(db, first.delegationId)).toBe(false);
    await snapshot(db, "second");
    expect(await delegationSnapshotsComplete(db, first.delegationId)).toBe(true);
    await item(db, "removed", first.delegationId, "queued", 3);
    await seed(db, (q) =>
      q.orm
        .insert(q.t.workItemSpecification)
        .values({ itemId: "removed", hash: "hash", revision: 1, present: 0 }),
    );
    expect(await delegationSnapshotsComplete(db, first.delegationId)).toBe(true);
  } finally {
    await close();
  }
});

test("merged blocker evidence keeps the newest check", async () => {
  const { db, close } = await tempStore();
  try {
    const first = await insertQueuedItem(db, { id: "first", now: 1 });
    await item(db, "second", first.delegationId, "queued", 1);
    await workspace(db);
    await snapshot(db, "first", 5, { out: { satisfied: false, reason: "old", checkedAt: 1 } });
    await snapshot(db, "second", 1, { out: { satisfied: true, reason: "new", checkedAt: 9 } });
    expect(
      (
        await readExternalBlockerEvidence(db, {
          workspaceId: "workspace",
          delegationId: first.delegationId,
        })
      ).out?.reason,
    ).toBe("new");
  } finally {
    await close();
  }
});
