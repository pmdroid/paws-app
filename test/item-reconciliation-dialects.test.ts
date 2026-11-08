import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  clearDelegationDependencyScopesSteps,
  countDelegationReconciliationChangeSteps,
  delegationHasOpenItemSteps,
  delegationReconciliationChangesSteps,
  deleteItemReconciliationEffectSteps,
  deleteItemReconciliationRequestSteps,
  itemReconciliationDueSteps,
  listItemReconciliationEffectsSteps,
  listItemReconciliationRequestsSteps,
  listReconciliationItemsSteps,
  listReconciliationTargetsSteps,
  listRelationItemsSteps,
  markItemSpecificationAbsentSteps,
  readReconciliationIdentitySteps,
  recordDelegationReconciledSteps,
  requestItemReconciliationSteps,
  saveItemReconciliationEffectSteps,
  saveItemSpecificationSteps,
  updateReconciledWorkItemSteps,
  type Db,
  type Q,
} from "../src/db";
import { forEachDialect, json, seed, withoutForeignKeys, type DialectDb } from "./dialects";

const open: DialectDb[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

function item(q: Q, id: string, values: Partial<typeof q.t.workItem.$inferInsert> = {}) {
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
    sessionKey: "s1",
    ...values,
  });
}

function dependencySnapshot(q: Q, db: Db, itemId: string) {
  return q.orm.insert(q.t.itemDependencySnapshot).values({
    itemId,
    workspaceId: "acme",
    generation: 1,
    scope: json(db, ["kept"]),
    linearStates: json(db, {}),
  });
}

async function connected(connect: () => Promise<DialectDb>): Promise<Db> {
  const handle = await connect();
  open.push(handle);
  await withoutForeignKeys(handle.db);
  await seed(
    handle.db,
    (q) =>
      q.orm
        .insert(q.t.workspace)
        .values({ id: "acme", linearOrganizationId: "org", name: "Acme", createdAt: 0 }),
    (q) =>
      q.orm.insert(q.t.linearSession).values({
        sessionId: "s1",
        organizationId: "org",
        teamId: "team",
        appUserId: "app",
        oauthClientId: "client",
        creatorId: "creator",
        generation: 3,
        createdAt: 0,
      }),
  );
  return handle.db;
}

const targets = (rows: { itemId: string }[]) => rows.map((row) => row.itemId).sort();

forEachDialect((connect) => {
  test("requests and effects list only the delegation's items", async () => {
    const db = await connected(connect);
    await seed(
      db,
      (q) => item(q, "b"),
      (q) => item(q, "a"),
      (q) => item(q, "other", { delegationId: "d2" }),
    );
    await db.transaction(function* (q) {
      expect(yield* requestItemReconciliationSteps(q, "b", "acme", "tb")).toBe(true);
      expect(yield* requestItemReconciliationSteps(q, "a", "acme", "ta")).toBe(true);
      yield* requestItemReconciliationSteps(q, "other", "acme", "to");
      yield* saveItemReconciliationEffectSteps(q, { itemId: "a", kind: "spec", token: "e1" });
      yield* saveItemReconciliationEffectSteps(q, { itemId: "a", kind: "spec", token: "e2" });
      yield* saveItemReconciliationEffectSteps(q, { itemId: "other", kind: "spec", token: "e3" });
    });
    expect(await db.run((q) => listItemReconciliationRequestsSteps(q, "d1"))).toEqual([
      { itemId: "a", token: "ta" },
      { itemId: "b", token: "tb" },
    ]);
    expect(await db.run((q) => listItemReconciliationEffectsSteps(q, "d1"))).toEqual([
      { itemId: "a", kind: "spec", token: "e2" },
    ]);
  });

  test("a request from another workspace is refused and a matching one replaces the token", async () => {
    const db = await connected(connect);
    await seed(db, (q) => item(q, "a"));
    await db.run((q) => requestItemReconciliationSteps(q, "a", "acme", "first"));
    expect(await db.run((q) => requestItemReconciliationSteps(q, "a", "other", "no"))).toBe(false);
    expect(await db.run((q) => requestItemReconciliationSteps(q, "a", "acme", "second"))).toBe(
      true,
    );
    expect(await db.run((q) => listItemReconciliationRequestsSteps(q, "d1"))).toEqual([
      { itemId: "a", token: "second" },
    ]);
  });

  test("requests and effects are deleted only by their exact token", async () => {
    const db = await connected(connect);
    await seed(db, (q) => item(q, "a"));
    const effect = { itemId: "a", kind: "removed", token: "e" };
    await db.run(function* (q) {
      yield* requestItemReconciliationSteps(q, "a", "acme", "r");
      yield* saveItemReconciliationEffectSteps(q, effect);
      yield* deleteItemReconciliationRequestSteps(q, "a", "acme", "stale");
      yield* deleteItemReconciliationRequestSteps(q, "a", "other", "r");
      yield* deleteItemReconciliationEffectSteps(q, { ...effect, token: "stale" });
    });
    expect(await db.run((q) => listItemReconciliationRequestsSteps(q, "d1"))).toHaveLength(1);
    expect(await db.run((q) => listItemReconciliationEffectsSteps(q, "d1"))).toHaveLength(1);
    await db.run(function* (q) {
      yield* deleteItemReconciliationRequestSteps(q, "a", "acme", "r");
      yield* deleteItemReconciliationEffectSteps(q, effect);
    });
    expect(await db.run((q) => listItemReconciliationRequestsSteps(q, "d1"))).toEqual([]);
    expect(await db.run((q) => listItemReconciliationEffectsSteps(q, "d1"))).toEqual([]);
  });

  test("the identity reads the session and prefers the owner as actor", async () => {
    const db = await connected(connect);
    await seed(
      db,
      (q) =>
        item(q, "a", {
          ownerUserId: "owner",
          delegatedBy: "delegator",
          taskKey: "root:item:issue-a",
          brief: json(db, { epic: { issueId: "epic" } }) as string,
        }),
      (q) =>
        q.orm
          .insert(q.t.workspaceUser)
          .values({ id: "owner", linearUserId: "linear-owner", name: "O", email: "o@x" }),
    );
    expect(await db.run((q) => readReconciliationIdentitySteps(q, "a", "acme"))).toEqual({
      delegationId: "d1",
      issueId: "epic",
      taskKey: "root",
      sessionId: "s1",
      organizationId: "org",
      teamId: "team",
      appUserId: "app",
      clientId: "client",
      creatorId: "creator",
      actorId: "linear-owner",
      generation: 3,
    });
  });

  test("the identity is null for another workspace, a stopped session or finished work", async () => {
    const db = await connected(connect);
    await seed(db, (q) => item(q, "a"));
    const read = (workspaceId: string) =>
      db.run((q) => readReconciliationIdentitySteps(q, "a", workspaceId));
    expect(await read("other")).toBeNull();
    expect((await read("acme"))?.actorId).toBe("creator");
    await seed(db, (q) =>
      q.orm.update(q.t.workItem).set({ state: "merged" }).where(eq(q.t.workItem.id, "a")),
    );
    expect(await read("acme")).toBeNull();
    await seed(
      db,
      (q) => q.orm.update(q.t.workItem).set({ state: "queued" }).where(eq(q.t.workItem.id, "a")),
      (q) =>
        q.orm
          .update(q.t.linearSession)
          .set({ stoppedAt: 1 })
          .where(eq(q.t.linearSession.sessionId, "s1")),
    );
    expect(await read("acme")).toBeNull();
  });

  test("items come in id order with their specification and brief text", async () => {
    const db = await connected(connect);
    await seed(
      db,
      (q) => item(q, "b", { brief: json(db, { goal: "b" }) as string }),
      (q) => item(q, "a"),
      (q) => item(q, "other", { delegationId: "d2" }),
    );
    await db.run((q) => saveItemSpecificationSteps(q, "a", "hash-a"));
    const rows = await db.run((q) => listReconciliationItemsSteps(q, "d1"));
    expect(rows.map(({ brief: _brief, ...row }) => row)).toEqual([
      { id: "a", issueId: "issue-a", hash: "hash-a", revision: 1, present: 1 },
      { id: "b", issueId: "issue-b", hash: null, revision: null, present: null },
    ]);
    expect(rows[0]?.brief).toBeNull();
    expect(JSON.parse(rows[1]?.brief ?? "null")).toEqual({ goal: "b" });
  });

  test("a specification counts a revision only when its hash changes", async () => {
    const db = await connected(connect);
    await seed(db, (q) => item(q, "a"));
    const spec = async () => (await db.run((q) => listReconciliationItemsSteps(q, "d1")))[0];
    await db.run((q) => saveItemSpecificationSteps(q, "a", "one"));
    await db.run((q) => saveItemSpecificationSteps(q, "a", "one"));
    expect(await spec()).toMatchObject({ hash: "one", revision: 1, present: 1 });
    await db.run((q) => saveItemSpecificationSteps(q, "a", "two"));
    expect(await spec()).toMatchObject({ hash: "two", revision: 2, present: 1 });
    await db.run((q) => markItemSpecificationAbsentSteps(q, "a", "ignored"));
    expect(await spec()).toMatchObject({ hash: "two", revision: 2, present: 0 });
    await db.run((q) => saveItemSpecificationSteps(q, "a", "two"));
    expect(await spec()).toMatchObject({ hash: "two", revision: 2, present: 1 });
  });

  test("an item without a specification is recorded absent with the given hash", async () => {
    const db = await connected(connect);
    await seed(db, (q) => item(q, "a"));
    await db.run((q) => markItemSpecificationAbsentSteps(q, "a", "hash"));
    expect((await db.run((q) => listReconciliationItemsSteps(q, "d1")))[0]).toMatchObject({
      hash: "hash",
      revision: 1,
      present: 0,
    });
  });

  test("updating a reconciled item changes its brief, title, identifier and position", async () => {
    const db = await connected(connect);
    await seed(db, (q) => item(q, "a"));
    await db.run((q) =>
      updateReconciledWorkItemSteps(q, "a", {
        brief: JSON.stringify({ goal: "new" }),
        title: "New",
        linearIdentifier: "PAS-9",
        position: 4,
      }),
    );
    const [row] = await db.run((q) => listReconciliationItemsSteps(q, "d1"));
    expect(JSON.parse(row?.brief ?? "null")).toEqual({ goal: "new" });
    const fields = await db.run((q) =>
      q.one(
        q.orm
          .select({
            title: q.t.workItem.title,
            identifier: q.t.workItem.linearIdentifier,
            position: q.t.workItem.position,
          })
          .from(q.t.workItem)
          .where(eq(q.t.workItem.id, "a")),
      ),
    );
    expect(fields).toEqual({ title: "New", identifier: "PAS-9", position: 4 });
  });

  test("clearing dependency scopes touches only the delegation's snapshots", async () => {
    const db = await connected(connect);
    await seed(
      db,
      (q) => item(q, "a"),
      (q) => item(q, "other", { delegationId: "d2" }),
      (q) => dependencySnapshot(q, db, "a"),
      (q) => dependencySnapshot(q, db, "other"),
    );
    await db.run((q) => clearDelegationDependencyScopesSteps(q, "d1"));
    const rows = await db.run((q) =>
      q.all(
        q.orm
          .select({
            itemId: q.t.itemDependencySnapshot.itemId,
            scope: q.t.itemDependencySnapshot.scope,
          })
          .from(q.t.itemDependencySnapshot)
          .orderBy(q.t.itemDependencySnapshot.itemId),
      ),
    );
    expect(rows).toEqual([
      { itemId: "a", scope: json(db, []) },
      { itemId: "other", scope: json(db, ["kept"]) },
    ]);
  });

  test("a delegation is open while any item is unfinished", async () => {
    const db = await connected(connect);
    await seed(
      db,
      (q) => item(q, "a", { state: "merged" }),
      (q) => item(q, "b", { state: "cancelled" }),
    );
    expect(await db.run((q) => delegationHasOpenItemSteps(q, "d1"))).toBe(false);
    await seed(db, (q) => item(q, "c", { state: "failed" }));
    expect(await db.run((q) => delegationHasOpenItemSteps(q, "d1"))).toBe(true);
  });

  test("changes are counted per delegation and kept apart from what was reconciled", async () => {
    const db = await connected(connect);
    await seed(db, (q) => item(q, "a"));
    const changes = () => db.run((q) => delegationReconciliationChangesSteps(q, "d1"));
    expect(await changes()).toBe(0);
    await db.run((q) => countDelegationReconciliationChangeSteps(q, "missing"));
    expect(await changes()).toBe(0);
    await db.run((q) => countDelegationReconciliationChangeSteps(q, "a"));
    await db.run((q) => countDelegationReconciliationChangeSteps(q, "a"));
    expect(await changes()).toBe(2);
    await db.run((q) => recordDelegationReconciledSteps(q, "d1", 1, 50));
    await db.run((q) => recordDelegationReconciledSteps(q, "d1", 2, 60));
    expect(await changes()).toBe(2);
    const row = await db.run((q) => q.one(q.orm.select().from(q.t.delegationReconciliation)));
    expect(row).toEqual({ delegationId: "d1", changes: 2, reconciledChanges: 2, reconciledAt: 60 });
  });

  test("an item is due when never reconciled, changed since, or past the cutoff", async () => {
    const db = await connected(connect);
    await seed(db, (q) => item(q, "a"));
    const due = (cutoff: number) => db.run((q) => itemReconciliationDueSteps(q, "a", cutoff));
    expect(await due(0)).toBe(true);
    expect(await db.run((q) => itemReconciliationDueSteps(q, "missing", 0))).toBe(false);
    await db.run((q) => recordDelegationReconciledSteps(q, "d1", 0, 100));
    expect(await due(99)).toBe(false);
    expect(await due(100)).toBe(true);
    await db.run((q) => countDelegationReconciliationChangeSteps(q, "a"));
    expect(await due(99)).toBe(true);
  });

  test("targets are open items with a live session in a known workspace", async () => {
    const db = await connected(connect);
    await seed(
      db,
      (q) => item(q, "a"),
      (q) => item(q, "no-session", { delegationId: "d2", sessionKey: null }),
      (q) => item(q, "done", { delegationId: "d3", state: "merged" }),
      (q) =>
        q.orm.insert(q.t.linearSession).values({
          sessionId: "stopped",
          organizationId: "org",
          stoppedAt: 1,
          createdAt: 0,
        }),
      (q) => item(q, "stopped", { delegationId: "d4", sessionKey: "stopped" }),
    );
    expect(await db.run((q) => listReconciliationTargetsSteps(q))).toEqual([
      { itemId: "a", workspaceId: "acme" },
    ]);
  });

  test("an issue selects its own delegation, its parent and the delegations it blocks", async () => {
    const db = await connected(connect);
    await seed(
      db,
      (q) => item(q, "hit"),
      (q) => item(q, "sibling"),
      (q) =>
        item(q, "child", {
          delegationId: "d2",
          brief: json(db, { epic: { issueId: "epic" } }) as string,
        }),
      (q) => item(q, "blocked", { delegationId: "d3" }),
      (q) => item(q, "unrelated", { delegationId: "d4" }),
      (q) =>
        q.orm
          .insert(q.t.taskBlock)
          .values({ blockerLinearIssueId: "blocker", blockedLinearIssueId: "issue-blocked" }),
    );
    const find = async (issueId: string, parentIssueId?: string | null, organizationId = "org") =>
      targets(
        await db.run((q) =>
          listReconciliationTargetsSteps(q, { issueId, organizationId, parentIssueId }),
        ),
      );
    expect(await find("issue-hit")).toEqual(["hit", "sibling"]);
    expect(await find("epic")).toEqual(["child"]);
    expect(await find("blocker")).toEqual(["blocked"]);
    expect(await find("nothing", "epic")).toEqual(["child"]);
    expect(await find("nothing", null)).toEqual([]);
    expect(await find("issue-hit", null, "other-org")).toEqual([]);
  });

  test("a removed blocked item's delegation is not selected by its blocker", async () => {
    const db = await connected(connect);
    await seed(
      db,
      (q) => item(q, "blocked"),
      (q) =>
        q.orm
          .insert(q.t.workItemSpecification)
          .values({ itemId: "blocked", hash: "h", revision: 1, present: 0 }),
      (q) =>
        q.orm
          .insert(q.t.taskBlock)
          .values({ blockerLinearIssueId: "blocker", blockedLinearIssueId: "issue-blocked" }),
    );
    expect(
      await db.run((q) =>
        listReconciliationTargetsSteps(q, { issueId: "blocker", organizationId: "org" }),
      ),
    ).toEqual([]);
  });

  test("relation items narrow by scope and need a snapshot", async () => {
    const db = await connected(connect);
    await seed(
      db,
      (q) => item(q, "b-held"),
      (q) => item(q, "a-open", { state: "running" }),
      (q) => item(q, "no-snapshot"),
      (q) => item(q, "gone"),
      (q) => item(q, "done", { state: "merged" }),
      (q) => dependencySnapshot(q, db, "b-held"),
      (q) => dependencySnapshot(q, db, "a-open"),
      (q) => dependencySnapshot(q, db, "gone"),
      (q) => dependencySnapshot(q, db, "done"),
      (q) =>
        q.orm
          .insert(q.t.workItemSpecification)
          .values({ itemId: "gone", hash: "h", revision: 1, present: 0 }),
      (q) =>
        q.orm
          .insert(q.t.itemHold)
          .values({ itemId: "b-held", reason: "blocked", blockers: json(db, []) }),
      (q) =>
        q.orm
          .insert(q.t.itemHold)
          .values({ itemId: "a-open", reason: "blocked", blockers: json(db, []) }),
    );
    const list = async (filter: { blockedOnly: boolean; itemId?: string }) =>
      (await db.run((q) => listRelationItemsSteps(q, filter))).map((row) => row.itemId);
    expect(await list({ blockedOnly: false })).toEqual(["a-open", "b-held"]);
    expect(await list({ blockedOnly: true })).toEqual(["b-held"]);
    expect(await list({ blockedOnly: true, itemId: "b-held" })).toEqual(["b-held"]);
    expect(await list({ blockedOnly: true, itemId: "a-open" })).toEqual([]);
    expect(await db.run((q) => listRelationItemsSteps(q, { blockedOnly: true }))).toEqual([
      { itemId: "b-held", workspaceId: "acme", issueId: "issue-b-held", delegationId: "d1" },
    ]);
  });
});
