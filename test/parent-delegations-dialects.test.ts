import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  activeParentSubIssueSteps,
  claimParentSubIssueSessionSteps,
  delegationHasLiveItemSteps,
  insertParentDelegationSteps,
  insertParentSubIssueSteps,
  listActiveParentDelegationIdsSteps,
  listFailedDelegationItemIdsSteps,
  listIssueBlockerItemsSteps,
  listParentSubIssuesSteps,
  moveParentSubIssueSessionSteps,
  outboxKeyExistsSteps,
  parentDelegationActiveSteps,
  parentSubIssueActiveSteps,
  parentSubIssueForSessionSteps,
  parentSubIssueIdentifierSteps,
  readParentDelegationSteps,
  setItemOwnerSteps,
  setParentDelegationErrorSteps,
  setParentSubIssueDelegationSteps,
  workspaceIssueHasOpenItemSteps,
  type Db,
  type Q,
} from "../src/db";
import {
  forEachDialect,
  insertWorkItem,
  jsonValue,
  seed,
  withoutForeignKeys,
  type DialectDb,
} from "./dialects";

const opened: DialectDb[] = [];
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close();
});

async function connect(open: () => Promise<DialectDb>, ...items: string[]): Promise<Db> {
  const handle = await open();
  opened.push(handle);
  for (const [index, id] of items.entries()) await insertWorkItem(handle.db, id, index);
  await withoutForeignKeys(handle.db);
  await seed(
    handle.db,
    (q) =>
      q.orm
        .insert(q.t.workspace)
        .values({ id: "acme", linearOrganizationId: "org", name: "Acme", createdAt: 0 }),
    (q) =>
      q.orm
        .insert(q.t.linearSession)
        .values({ sessionId: "s", organizationId: "org", createdAt: 0 }),
  );
  return handle.db;
}

const item = (id: string, fields: Record<string, unknown>) => (q: Q) =>
  q.orm.update(q.t.workItem).set(fields).where(eq(q.t.workItem.id, id));

const edge = { blockerLinearIssueId: "i1", blockedLinearIssueId: "i2" };

function* parentSteps(q: Q) {
  yield* insertParentDelegationSteps(q, {
    delegationId: "parent",
    workspaceId: "acme",
    organizationId: "org",
    parentIssueId: "epic",
    parentIdentifier: "PAS-1",
    title: "Epic",
    sessionId: "parent-session",
    ownerUserId: "owner",
    edges: [edge],
    createdAt: 5,
  });
  for (const [position, issueId] of ["i2", "i1"].entries())
    yield* insertParentSubIssueSteps(q, {
      parentDelegationId: "parent",
      workspaceId: "acme",
      issueId,
      identifier: `PAS-${issueId}`,
      title: issueId,
      url: null,
      position: 1 - position,
    });
}

forEachDialect((open) => {
  test("a parent delegation and its sub-issues read back, claim sessions and record errors", async () => {
    const db = await connect(open);
    await db.run(parentSteps);
    expect(await db.run((q) => readParentDelegationSteps(q, "parent"))).toEqual({
      delegationId: "parent",
      workspaceId: "acme",
      organizationId: "org",
      sessionId: "parent-session",
      ownerUserId: "owner",
      edges: [edge],
      stoppedAt: null,
    });
    expect(await db.run((q) => readParentDelegationSteps(q, "missing"))).toBeNull();
    expect(
      (await db.run((q) => listParentSubIssuesSteps(q, "parent"))).map((sub) => sub.issueId),
    ).toEqual(["i1", "i2"]);
    expect(await db.run((q) => parentDelegationActiveSteps(q, "acme", "epic"))).toBe(true);
    expect(await db.run((q) => parentDelegationActiveSteps(q, "acme", "i1"))).toBe(false);
    expect(await db.run((q) => listActiveParentDelegationIdsSteps(q))).toEqual(["parent"]);
    expect(await db.run((q) => parentSubIssueActiveSteps(q, "acme", "i1"))).toBe(true);
    expect(await db.run((q) => parentSubIssueActiveSteps(q, "acme", "epic"))).toBe(false);
    expect(await db.run((q) => parentSubIssueIdentifierSteps(q, "parent", "i2"))).toBe("PAS-i2");
    expect(await db.run((q) => parentSubIssueIdentifierSteps(q, "parent", "x"))).toBeUndefined();
    expect((await db.run((q) => activeParentSubIssueSteps(q, "i1", "org")))?.identifier).toBe(
      "PAS-i1",
    );
    expect(await db.run((q) => activeParentSubIssueSteps(q, "i1", "other"))).toBeNull();

    expect(await db.run((q) => claimParentSubIssueSessionSteps(q, "parent", "i1", "s1"))).toBe(1);
    expect(await db.run((q) => claimParentSubIssueSessionSteps(q, "parent", "i1", "s2"))).toBe(0);
    await db.run((q) => setParentSubIssueDelegationSteps(q, "s1", "d1"));
    expect(await db.run((q) => parentSubIssueForSessionSteps(q, "s1"))).toEqual({
      parentDelegationId: "parent",
      issueId: "i1",
      identifier: "PAS-i1",
      title: "i1",
      url: null,
      sessionId: "s1",
      delegationId: "d1",
    });
    await db.run((q) =>
      moveParentSubIssueSessionSteps(q, {
        parentDelegationId: "parent",
        issueId: "i1",
        from: "s1",
        to: "s3",
      }),
    );
    expect(await db.run((q) => parentSubIssueForSessionSteps(q, "s1"))).toBeNull();
    expect((await db.run((q) => parentSubIssueForSessionSteps(q, "s3")))?.delegationId).toBeNull();

    await db.run((q) => setParentDelegationErrorSteps(q, "parent", "boom"));
    const lastError = () =>
      db.run(function* (q) {
        const row = yield* q.one(
          q.orm.select({ lastError: q.t.parentDelegation.lastError }).from(q.t.parentDelegation),
        );
        return row?.lastError;
      });
    expect(await lastError()).toBe("boom");
    await db.run((q) => setParentDelegationErrorSteps(q, "parent", null));
    expect(await lastError()).toBeNull();
  });

  test("work items a parent reads: blockers, open and failed items, owner and summary key", async () => {
    const db = await connect(open, "old", "new", "gone", "other");
    await seed(
      db,
      item("old", { linearIssueId: "b", sessionKey: "s", state: "failed", delegationId: "d" }),
      item("new", { linearIssueId: "b", sessionKey: "s", state: "merged", delegationId: "d" }),
      item("gone", { linearIssueId: "b", sessionKey: "s", state: "cancelled" }),
      item("other", { linearIssueId: "b", sessionKey: null, state: "completed" }),
      (q) => q.orm.insert(q.t.workItemTask).values({ itemId: "new", mode: "code" }),
      (q) =>
        q.orm.insert(q.t.remoteMergeFact).values({
          itemId: "new",
          repositoryOwner: "o",
          repositoryName: "r",
          pullNumber: 1,
          mergeSha: "sha",
          confirmedAt: 0,
        }),
      (q) =>
        q.orm.insert(q.t.outbox).values({
          target: "linear",
          op: "activity",
          orderingKey: "s",
          idempotencyKey: "parent-summary:parent",
          payload: jsonValue(q, {}),
          createdAt: 0,
        }),
    );
    expect(await db.run((q) => listIssueBlockerItemsSteps(q, "acme", "b"))).toEqual([
      { state: "failed", mode: null, cancelRequested: 0, mergeSha: null },
      { state: "merged", mode: "code", cancelRequested: 0, mergeSha: "sha" },
    ]);
    expect(await db.run((q) => workspaceIssueHasOpenItemSteps(q, "acme", "b"))).toBe(true);
    await seed(db, item("old", { state: "cancelled" }));
    expect(await db.run((q) => workspaceIssueHasOpenItemSteps(q, "acme", "b"))).toBe(false);
    await seed(db, item("old", { state: "failed" }));

    expect(await db.run((q) => delegationHasLiveItemSteps(q, "d"))).toBe(true);
    await seed(db, item("new", { state: "cancelled" }));
    expect(await db.run((q) => delegationHasLiveItemSteps(q, "d"))).toBe(false);
    expect(await db.run((q) => listFailedDelegationItemIdsSteps(q, "d"))).toEqual(["old"]);

    await db.run((q) => setItemOwnerSteps(q, "old", "owner"));
    const owner = await db.run(function* (q) {
      const row = yield* q.one(
        q.orm
          .select({ owner: q.t.workItem.ownerUserId })
          .from(q.t.workItem)
          .where(eq(q.t.workItem.id, "old")),
      );
      return row?.owner;
    });
    expect(owner).toBe("owner");

    expect(await db.run((q) => outboxKeyExistsSteps(q, "parent-summary:parent"))).toBe(true);
    expect(await db.run((q) => outboxKeyExistsSteps(q, "parent-summary:other"))).toBe(false);
  });
});
