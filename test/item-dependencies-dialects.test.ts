import { afterEach, expect, test } from "bun:test";
import {
  delegationHasItemWithoutSnapshotSteps,
  delegationHasReconciliationWorkSteps,
  dependencySnapshotGenerationSteps,
  itemSpecificationPresentSteps,
  latestIssueIdentifierSteps,
  listBlocksOfSteps,
  listDelegationExternalEvidenceSteps,
  listManagedBlockerItemsSteps,
  listPresentDelegationItemsSteps,
  readDependencySnapshotSteps,
  saveDependencySnapshotSteps,
  type Db,
  type Q,
} from "../src/db";
import { forEachDialect, json, seed, withoutForeignKeys, type DialectDb } from "./dialects";

const open: DialectDb[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

async function connected(connect: () => Promise<DialectDb>): Promise<Db> {
  const handle = await connect();
  open.push(handle);
  await withoutForeignKeys(handle.db);
  return handle.db;
}

function item(
  q: Q,
  id: string,
  values: Partial<typeof q.t.workItem.$inferInsert> = {},
): PromiseLike<unknown> {
  return q.orm.insert(q.t.workItem).values({
    id,
    delegationId: "d1",
    linearIssueId: `issue-${id}`,
    linearIdentifier: `PAS-${id}`,
    title: id,
    state: "queued",
    branchName: `paws/${id}`,
    position: 0,
    createdAt: 0,
    ...values,
  });
}

const snapshot = {
  workspaceId: "w1",
  generation: 1,
  scope: '{"items":["a"]}',
  linearStates: '{"a":"started"}',
  linearIdentifiers: '["PAS-a"]',
};

forEachDialect((connect) => {
  test("present delegation items come in position order with their mode and brief", async () => {
    const db = await connected(connect);
    await seed(
      db,
      (q) => item(q, "b", { position: 2, brief: json(db, { goal: "b" }) as string }),
      (q) => item(q, "a", { position: 1, cancelRequested: 1 }),
      (q) => item(q, "gone", { position: 0 }),
      (q) => item(q, "other", { delegationId: "d2" }),
      (q) => q.orm.insert(q.t.workItemTask).values({ itemId: "a", mode: "answer" }),
      (q) =>
        q.orm
          .insert(q.t.workItemSpecification)
          .values({ itemId: "gone", hash: "h", revision: 1, present: 0 }),
    );
    expect(await db.run((q) => listPresentDelegationItemsSteps(q, "d1"))).toEqual([
      {
        id: "a",
        delegationId: "d1",
        linearIssueId: "issue-a",
        identifier: "PAS-a",
        title: "a",
        state: "queued",
        cancelRequested: 1,
        mode: "answer",
        brief: null,
      },
      {
        id: "b",
        delegationId: "d1",
        linearIssueId: "issue-b",
        identifier: "PAS-b",
        title: "b",
        state: "queued",
        cancelRequested: 0,
        mode: null,
        brief: '{"goal":"b"}',
      },
    ]);
    expect(await db.run((q) => itemSpecificationPresentSteps(q, "a"))).toBe(1);
    expect(await db.run((q) => itemSpecificationPresentSteps(q, "gone"))).toBe(0);
    expect(await db.run((q) => itemSpecificationPresentSteps(q, "missing"))).toBeNull();
  });

  test("a snapshot is saved, replaced only within its workspace and read back as text", async () => {
    const db = await connected(connect);
    await seed(
      db,
      (q) => item(q, "a"),
      (q) => item(q, "b", { position: 1 }),
    );
    expect(await db.run((q) => delegationHasItemWithoutSnapshotSteps(q, "d1"))).toBe(true);
    expect(await db.run((q) => readDependencySnapshotSteps(q, "a"))).toBeNull();
    expect(await db.run((q) => dependencySnapshotGenerationSteps(q, "a"))).toBeUndefined();

    await db.run((q) => saveDependencySnapshotSteps(q, { itemId: "a", ...snapshot }));
    await db.run((q) =>
      saveDependencySnapshotSteps(q, {
        itemId: "a",
        ...snapshot,
        workspaceId: "w2",
        generation: 9,
      }),
    );
    expect(await db.run((q) => readDependencySnapshotSteps(q, "a"))).toEqual(snapshot);
    await db.run((q) =>
      saveDependencySnapshotSteps(q, { itemId: "a", ...snapshot, generation: 2 }),
    );
    expect(await db.run((q) => dependencySnapshotGenerationSteps(q, "a"))).toBe(2);
    expect(await db.run((q) => delegationHasItemWithoutSnapshotSteps(q, "d1"))).toBe(true);

    await db.run((q) => saveDependencySnapshotSteps(q, { itemId: "b", ...snapshot }));
    expect(await db.run((q) => delegationHasItemWithoutSnapshotSteps(q, "d1"))).toBe(false);
    expect(await db.run((q) => listDelegationExternalEvidenceSteps(q, "w1", "d1"))).toEqual([
      "{}",
      "{}",
    ]);
    expect(await db.run((q) => listDelegationExternalEvidenceSteps(q, "w2", "d1"))).toEqual([]);
  });

  test("reconciliation work counts requests and effects of the delegation's items", async () => {
    const db = await connected(connect);
    await seed(
      db,
      (q) => item(q, "a"),
      (q) => item(q, "b", { delegationId: "d2" }),
    );
    expect(await db.run((q) => delegationHasReconciliationWorkSteps(q, "d1"))).toBe(false);
    await seed(db, (q) =>
      q.orm.insert(q.t.itemReconciliationEffect).values({ itemId: "a", kind: "spec", token: "t" }),
    );
    expect(await db.run((q) => delegationHasReconciliationWorkSteps(q, "d1"))).toBe(true);
    await seed(db, (q) =>
      q.orm
        .insert(q.t.itemReconciliationRequest)
        .values({ itemId: "b", workspaceId: "w1", token: "t" }),
    );
    expect(await db.run((q) => delegationHasReconciliationWorkSteps(q, "d2"))).toBe(true);
  });

  test("blocks, identifiers and managed blockers come from the issue's other delegations", async () => {
    const db = await connected(connect);
    await seed(
      db,
      (q) => item(q, "mine", { linearIssueId: "blocker", sessionKey: "s1" }),
      (q) =>
        item(q, "old", {
          delegationId: "d2",
          linearIssueId: "blocker",
          linearIdentifier: "PAS-1",
          sessionKey: "s1",
          state: "merged",
          createdAt: 1,
        }),
      (q) =>
        item(q, "new", {
          delegationId: "d3",
          linearIssueId: "blocker",
          linearIdentifier: "PAS-2",
          sessionKey: "s1",
          state: "completed",
          createdAt: 2,
        }),
      (q) =>
        item(q, "absent", {
          delegationId: "d4",
          linearIssueId: "blocker",
          sessionKey: "s1",
          state: "cancelled",
          createdAt: 3,
        }),
      (q) =>
        q.orm
          .insert(q.t.workItemSpecification)
          .values({ itemId: "absent", hash: "h", revision: 1, present: 0 }),
      (q) =>
        q.orm
          .insert(q.t.linearSession)
          .values({ sessionId: "s1", organizationId: "o1", createdAt: 0 }),
      (q) =>
        q.orm
          .insert(q.t.workspace)
          .values({ id: "w1", linearOrganizationId: "o1", name: "w", createdAt: 0 }),
      (q) => q.orm.insert(q.t.workItemTask).values({ itemId: "old", mode: "code" }),
      (q) =>
        q.orm.insert(q.t.remoteMergeFact).values({
          itemId: "old",
          repositoryOwner: "o",
          repositoryName: "r",
          pullNumber: 1,
          mergeSha: "sha",
          confirmedAt: 0,
        }),
      (q) =>
        q.orm.insert(q.t.taskBlock).values([
          { blockerLinearIssueId: "blocker", blockedLinearIssueId: "x" },
          { blockerLinearIssueId: "blocker", blockedLinearIssueId: "y" },
        ]),
    );
    expect(await db.run((q) => listBlocksOfSteps(q, []))).toEqual([]);
    expect(await db.run((q) => listBlocksOfSteps(q, ["x"]))).toEqual([
      { blockerLinearIssueId: "blocker", blockedLinearIssueId: "x" },
    ]);
    expect(await db.run((q) => latestIssueIdentifierSteps(q, "blocker"))).toBe("PAS-absent");
    expect(await db.run((q) => latestIssueIdentifierSteps(q, "none"))).toBeUndefined();
    expect(
      await db.run((q) =>
        listManagedBlockerItemsSteps(q, { workspaceId: "w1", issueId: "blocker", itemId: "mine" }),
      ),
    ).toEqual([
      { state: "merged", mode: "code", cancelRequested: 0, mergeSha: "sha" },
      { state: "completed", mode: null, cancelRequested: 0, mergeSha: null },
    ]);
  });
});
