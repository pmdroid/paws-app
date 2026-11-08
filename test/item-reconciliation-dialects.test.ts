import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  activeReconciliationTargetsSteps,
  clearDelegationDependencyScopesSteps,
  countDelegationChangeSteps,
  delegationHasOpenItemSteps,
  delegationReconciliationChangesSteps,
  delegationReconciliationDueSteps,
  deleteReconciliationEffectSteps,
  deleteReconciliationRequestSteps,
  listDelegationReconciliationEffectsSteps,
  listDelegationReconciliationRequestsSteps,
  listReconciliationItemsSteps,
  listRelationItemsSteps,
  markDelegationReconciledSteps,
  markSpecificationAbsentSteps,
  readDependencySnapshotSteps,
  readReconciliationAuthoritySteps,
  requestItemReconciliationSteps,
  saveReconciliationEffectSteps,
  saveSpecificationSteps,
  updateReconciledItemSteps,
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

const item = (id: string, fields: Record<string, unknown>) => (q: Q) =>
  q.orm.update(q.t.workItem).set(fields).where(eq(q.t.workItem.id, id));

const snapshot = (itemId: string, scope: unknown) => (q: Q) =>
  q.orm.insert(q.t.itemDependencySnapshot).values({
    itemId,
    workspaceId: "acme",
    generation: 1,
    scope: jsonValue(q, scope),
    linearStates: jsonValue(q, {}),
  });

async function connect(open: () => Promise<DialectDb>): Promise<Db> {
  const handle = await open();
  opened.push(handle);
  await insertWorkItem(handle.db, "a", 0);
  await insertWorkItem(handle.db, "b", 1);
  await withoutForeignKeys(handle.db);
  await seed(
    handle.db,
    (q) =>
      q.orm
        .insert(q.t.workspace)
        .values({ id: "acme", linearOrganizationId: "org", name: "Acme", createdAt: 0 }),
    (q) =>
      q.orm.insert(q.t.workspaceUser).values({
        id: "owner",
        linearUserId: "lin-owner",
        name: "Owner",
        email: "o@example.com",
      }),
    (q) =>
      q.orm.insert(q.t.linearSession).values({
        sessionId: "s",
        organizationId: "org",
        oauthClientId: "client",
        appUserId: "app",
        teamId: "team",
        createdAt: 0,
      }),
    item("a", {
      delegationId: "d",
      sessionKey: "s",
      ownerUserId: "owner",
      taskKey: "task:item:issue-a",
    }),
    item("b", { delegationId: "d", sessionKey: "s" }),
  );
  return handle.db;
}

const ids = (rows: { itemId: string }[]) => rows.map((row) => row.itemId).sort();

forEachDialect((open) => {
  test("the reconciliation authority, active targets and relation items read the open delegation", async () => {
    const db = await connect(open);
    expect(
      await db.run((q) =>
        readReconciliationAuthoritySteps(q, { itemId: "a", workspaceId: "acme" }),
      ),
    ).toEqual({
      delegationId: "d",
      issueId: "issue-a",
      taskKey: "task",
      sessionId: "s",
      organizationId: "org",
      teamId: "team",
      appUserId: "app",
      clientId: "client",
      creatorId: null,
      actorId: "lin-owner",
      generation: 0,
    });
    expect(
      await db.run((q) => readReconciliationAuthoritySteps(q, { itemId: "a", workspaceId: "x" })),
    ).toBeNull();

    const targets = (issue?: Parameters<typeof activeReconciliationTargetsSteps>[1]) =>
      db.run((q) => activeReconciliationTargetsSteps(q, issue));
    expect(ids(await targets())).toEqual(["a", "b"]);
    expect((await targets()).every((target) => target.workspaceId === "acme")).toBe(true);
    expect(ids(await targets({ issueId: "issue-b", organizationId: "org" }))).toEqual(["a", "b"]);
    expect(await targets({ issueId: "issue-b", organizationId: "other" })).toEqual([]);
    expect(await targets({ issueId: "x", organizationId: "org" })).toEqual([]);
    expect(
      ids(await targets({ issueId: "y", organizationId: "org", parentIssueId: "issue-a" })),
    ).toEqual(["a"]);
    await seed(db, (q) =>
      q.orm
        .insert(q.t.taskBlock)
        .values({ blockerLinearIssueId: "x", blockedLinearIssueId: "issue-a" }),
    );
    expect(ids(await targets({ issueId: "x", organizationId: "org" }))).toEqual(["a", "b"]);

    await seed(db, snapshot("a", []), snapshot("b", []), (q) =>
      q.orm
        .insert(q.t.itemHold)
        .values({ itemId: "b", reason: "blocked", blockers: jsonValue(q, []) }),
    );
    const relations = (scope: { blocked: boolean; itemId?: string }) =>
      db.run((q) => listRelationItemsSteps(q, scope));
    expect(await relations({ blocked: false })).toEqual([
      { itemId: "a", workspaceId: "acme", issueId: "issue-a", delegationId: "d" },
      { itemId: "b", workspaceId: "acme", issueId: "issue-b", delegationId: "d" },
    ]);
    expect(ids(await relations({ blocked: true }))).toEqual(["b"]);
    expect(await relations({ blocked: true, itemId: "a" })).toEqual([]);
    expect(ids(await relations({ blocked: false, itemId: "a" }))).toEqual(["a"]);

    expect(await db.run((q) => delegationHasOpenItemSteps(q, "d"))).toBe(true);
    await seed(db, item("a", { state: "completed" }), item("b", { state: "cancelled" }));
    expect(await db.run((q) => delegationHasOpenItemSteps(q, "d"))).toBe(false);
    expect(await targets()).toEqual([]);
  });

  test("requests and effects are stored once per item and deleted by their token", async () => {
    const db = await connect(open);
    const request = (workspaceId: string, token: string) =>
      db.run((q) => requestItemReconciliationSteps(q, "a", workspaceId, token));
    expect(await request("acme", "t1")).toBe(1);
    expect(await request("acme", "t2")).toBe(1);
    expect(await request("other", "t3")).toBe(0);
    const requests = () => db.run((q) => listDelegationReconciliationRequestsSteps(q, "d"));
    expect(await requests()).toEqual([{ itemId: "a", token: "t2" }]);
    await db.run((q) => deleteReconciliationRequestSteps(q, "a", "acme", "t1"));
    expect(await requests()).toHaveLength(1);
    await db.run((q) => deleteReconciliationRequestSteps(q, "a", "acme", "t2"));
    expect(await requests()).toEqual([]);

    await db.run((q) => saveReconciliationEffectSteps(q, "a", "spec", "x"));
    await db.run((q) => saveReconciliationEffectSteps(q, "a", "spec", "y"));
    await db.run((q) => saveReconciliationEffectSteps(q, "b", "removed", "z"));
    const effects = async () =>
      (await db.run((q) => listDelegationReconciliationEffectsSteps(q, "d"))).sort((l, r) =>
        l.itemId.localeCompare(r.itemId),
      );
    expect(await effects()).toEqual([
      { itemId: "a", kind: "spec", token: "y" },
      { itemId: "b", kind: "removed", token: "z" },
    ]);
    await db.run((q) =>
      deleteReconciliationEffectSteps(q, { itemId: "a", kind: "spec", token: "x" }),
    );
    expect(await effects()).toHaveLength(2);
    await db.run((q) =>
      deleteReconciliationEffectSteps(q, { itemId: "a", kind: "spec", token: "y" }),
    );
    expect(await effects()).toEqual([{ itemId: "b", kind: "removed", token: "z" }]);
  });

  test("changes are counted per delegation and a reconcile is due until it covers them", async () => {
    const db = await connect(open);
    const changes = () => db.run((q) => delegationReconciliationChangesSteps(q, "d"));
    const due = (before: number) => db.run((q) => delegationReconciliationDueSteps(q, "a", before));
    expect(await changes()).toBeUndefined();
    expect(await due(0)).toBe(true);
    await db.run((q) => countDelegationChangeSteps(q, "a"));
    await db.run((q) => countDelegationChangeSteps(q, "b"));
    await db.run((q) => countDelegationChangeSteps(q, "missing"));
    expect(await changes()).toBe(2);
    await db.run((q) => markDelegationReconciledSteps(q, "d", 2, 50));
    expect(await changes()).toBe(2);
    expect(await due(10)).toBe(false);
    expect(await due(50)).toBe(true);
    await db.run((q) => countDelegationChangeSteps(q, "a"));
    expect(await due(10)).toBe(true);
    await db.run((q) => markDelegationReconciledSteps(q, "fresh", 0, 1));
    expect(await db.run((q) => delegationReconciliationChangesSteps(q, "fresh"))).toBe(0);
  });

  test("specifications, reconciled items and dependency scopes are written", async () => {
    const db = await connect(open);
    const items = () => db.run((q) => listReconciliationItemsSteps(q, "d"));
    expect(await items()).toEqual([
      { id: "a", issueId: "issue-a", brief: null, hash: null, revision: null, present: null },
      { id: "b", issueId: "issue-b", brief: null, hash: null, revision: null, present: null },
    ]);
    await db.run((q) => saveSpecificationSteps(q, "a", "h1"));
    await db.run((q) => saveSpecificationSteps(q, "a", "h1"));
    expect((await items())[0]).toMatchObject({ hash: "h1", revision: 1, present: 1 });
    await db.run((q) => saveSpecificationSteps(q, "a", "h2"));
    await db.run((q) => markSpecificationAbsentSteps(q, "a", "ignored"));
    await db.run((q) => markSpecificationAbsentSteps(q, "b", "hb"));
    expect(
      (await items()).map(({ hash, revision, present }) => ({ hash, revision, present })),
    ).toEqual([
      { hash: "h2", revision: 2, present: 0 },
      { hash: "hb", revision: 1, present: 0 },
    ]);
    await db.run((q) => saveSpecificationSteps(q, "a", "h2"));
    expect((await items())[0]).toMatchObject({ hash: "h2", revision: 2, present: 1 });

    const brief = { issue: { issueId: "issue-a", title: "New" }, epic: null };
    await db.run((q) =>
      updateReconciledItemSteps(q, "a", {
        brief,
        title: "New",
        linearIdentifier: "PAS-9",
        position: 4,
      }),
    );
    expect(JSON.parse((await items())[0]!.brief!)).toEqual(brief);
    const fields = await db.run(function* (q) {
      const { workItem } = q.t;
      return yield* q.one(
        q.orm
          .select({
            title: workItem.title,
            identifier: workItem.linearIdentifier,
            position: workItem.position,
          })
          .from(workItem)
          .where(eq(workItem.id, "a")),
      );
    });
    expect(fields).toEqual({ title: "New", identifier: "PAS-9", position: 4 });

    await seed(db, snapshot("a", ["x"]), snapshot("b", ["y"]));
    await db.run((q) => clearDelegationDependencyScopesSteps(q, "d"));
    for (const id of ["a", "b"])
      expect(JSON.parse((await db.run((q) => readDependencySnapshotSteps(q, id)))!.scope)).toEqual(
        [],
      );
  });
});
