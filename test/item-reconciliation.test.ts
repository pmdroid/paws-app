import { afterEach, expect, test } from "bun:test";
import { count, eq, sql } from "drizzle-orm";
import { bindLinearSessionTask, recordLinearInstallation, type Db } from "../src/db";
import { createItemReconciler, intakeDelegatedIssue } from "../src/intake";
import { createFakeLinearIssueLifecycle, createFakeTracker } from "../src/linear";
import { seed } from "./dialects";
import { tempStore } from "./pglite";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function store(): Promise<Db> {
  const { db, close } = await tempStore();
  closers.push(close);
  return db;
}

const workspace = (db: Db) =>
  seed(db, (q) =>
    q.orm
      .insert(q.t.workspace)
      .values({ id: "workspace", linearOrganizationId: "org", name: "Workspace", createdAt: 1000 }),
  );

test("a spec change on the item's issue is reconciled through the item", async () => {
  const db = await store();
  const tracker = createFakeTracker([
    {
      linearIssueId: "parent",
      identifier: "SYNC-1",
      title: "Parent",
      description: "Parent criteria",
      subIssues: [
        { linearIssueId: "child", identifier: "SYNC-2", title: "Child", description: "Original" },
      ],
    },
  ]);
  const lifecycle = createFakeLinearIssueLifecycle({
    id: "parent",
    teamId: "team",
    stateType: "started",
    assigneeId: null,
    delegateId: "app",
  });
  lifecycle.issues.set("child", { ...lifecycle.issue, id: "child" });
  const intake = await intakeDelegatedIssue(db, tracker, {
    linearIssueId: "parent",
    now: 1000,
  });
  expect(intake.ok).toBe(true);
  if (!intake.ok) return;
  const itemId = intake.items[0]!.id;
  await workspace(db);
  await seed(db, (q) =>
    q.orm.insert(q.t.workspaceUser).values({
      id: "person",
      linearUserId: "linear-person",
      name: "Person",
      email: "person@example.test",
    }),
  );
  await recordLinearInstallation(db, {
    organizationId: "org",
    oauthClientId: "client",
    appUserId: "app",
    sessionId: "session",
    teamId: "team",
    observedAtMs: 1000,
  });
  await bindLinearSessionTask(db, "session", intake.delegation.id, {
    actorId: "linear-person",
  });
  const changed: string[][] = [];
  const reconciler = createItemReconciler({
    store: db,
    tracker,
    lifecycle,
    *onChanges(_q, changes) {
      yield* [];
      changed.push(changes.specChangedItemIds);
    },
  });
  await reconciler.reconcile({ itemId, workspaceId: "workspace" });
  const specification = () =>
    db.run((q) =>
      q.one(
        q.orm
          .select({ revision: q.t.workItemSpecification.revision })
          .from(q.t.workItemSpecification)
          .where(eq(q.t.workItemSpecification.itemId, itemId)),
      ),
    );
  expect((await specification())?.revision).toBe(1);
  expect(changed.at(-1)).toEqual([]);
  tracker.epics.get("parent")!.subIssues[0]!.description = "Changed acceptance criteria";
  await reconciler.reconcile({ itemId, workspaceId: "workspace" });
  expect((await specification())?.revision).toBe(2);
  expect(changed.at(-1)).toEqual([itemId]);
  expect(
    await db.run((q) =>
      q.one(
        q.orm
          .select({ name: sql<string | null>`to_regclass('epic_reconciliation_request')::text` })
          .from(sql`(SELECT 1) AS one`),
      ),
    ),
  ).toEqual({ name: null });
  expect(
    await db.run((q) => q.one(q.orm.select({ n: count() }).from(q.t.itemReconciliationRequest))),
  ).toEqual({ n: 0 });
  await reconciler.close();
});

test("a reconcile handed the intake's reads writes the scheduler rows without reading Linear", async () => {
  const db = await store();
  const snapshot = {
    linearIssueId: "issue",
    identifier: "ONE-1",
    title: "Lone issue",
    description: "Criteria",
    teamId: "team",
    stateType: "unstarted",
    subIssues: [],
  };
  const intake = await intakeDelegatedIssue(db, createFakeTracker([snapshot]), {
    linearIssueId: "issue",
    now: 1000,
  });
  expect(intake.ok).toBe(true);
  if (!intake.ok) return;
  const itemId = intake.items[0]!.id;
  await workspace(db);
  await recordLinearInstallation(db, {
    organizationId: "org",
    oauthClientId: "client",
    appUserId: "app",
    sessionId: "session",
    teamId: "team",
    observedAtMs: 1000,
  });
  await bindLinearSessionTask(db, "session", intake.delegation.id);
  const unread = async (): Promise<never> => {
    throw new Error("The intake's reads must not be repeated");
  };
  const reconciler = createItemReconciler({
    store: db,
    tracker: { loadEpic: unread, listDeps: unread },
    lifecycle: { inspect: unread },
    *onChanges() {
      yield* [];
    },
  });
  await reconciler.reconcile({
    itemId,
    workspaceId: "workspace",
    known: { snapshot, edges: [] },
  });
  expect(
    await db.run((q) =>
      q.one(
        q.orm
          .select({ present: q.t.workItemSpecification.present })
          .from(q.t.workItemSpecification)
          .where(eq(q.t.workItemSpecification.itemId, itemId)),
      ),
    ),
  ).toEqual({ present: 1 });
  expect(
    await db.run((q) =>
      q.one(
        q.orm
          .select({ generation: q.t.itemDependencySnapshot.generation })
          .from(q.t.itemDependencySnapshot)
          .where(eq(q.t.itemDependencySnapshot.itemId, itemId)),
      ),
    ),
  ).toEqual({ generation: 1 });
  await reconciler.close();
});
