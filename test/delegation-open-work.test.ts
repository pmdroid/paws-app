import { syncSteps } from "../src/runner-backend";
import { expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { bindLinearSessionTask, recordLinearInstallation, type Db } from "../src/db";
import {
  createItemReconciler,
  intakeDelegatedIssue,
  readyItemsSteps,
  syncItemDependencies,
} from "../src/intake";
import { createFakeLinearIssueLifecycle, createFakeTracker } from "../src/linear";
import { seed } from "./dialects";
import { workspaceDispatchPg } from "./fake-workspace";
import { tempStore } from "./pglite";

const issue = {
  linearIssueId: "only",
  identifier: "CAN-1",
  title: "Only",
  description: null,
  subIssues: [],
};

const epicTables = (db: Db) =>
  db.run((q) =>
    q.all(
      q.orm
        .select({ name: sql<string>`table_name` })
        .from(sql`information_schema.tables`)
        .where(sql`table_name = 'epic'`),
    ),
  );

async function install(db: Db, delegationId: string): Promise<void> {
  await seed(
    db,
    (q) =>
      q.orm.insert(q.t.workspace).values({
        id: "workspace",
        linearOrganizationId: "org",
        name: "Workspace",
        createdAt: 1000,
      }),
    (q) =>
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
  await bindLinearSessionTask(db, "session", delegationId, { actorId: "linear-person" });
}

test("a delegation whose only item is cancelled is no longer treated as running by reconciliation and readiness", async () => {
  const { db, close } = await tempStore();
  const tracker = createFakeTracker([issue]);
  const lifecycle = createFakeLinearIssueLifecycle({
    id: "only",
    teamId: "team",
    stateType: "started",
    assigneeId: null,
    delegateId: "app",
  });
  const reconciler = createItemReconciler({
    store: db,
    tracker,
    lifecycle,
    onChanges: () => syncSteps(() => {}),
  });
  try {
    const intake = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "only",
      now: 1000,
    });
    expect(intake.ok).toBe(true);
    if (!intake.ok) return;
    const itemId = intake.items[0]!.id;
    await install(db, intake.delegation.id);
    const target = { itemId, workspaceId: "workspace" };
    expect((await db.run((q) => readyItemsSteps(q, target))).heldItemIds).toEqual([itemId]);
    await reconciler.reconcile(target);
    await seed(db, (q) =>
      q.orm.update(q.t.workItem).set({ state: "cancelled" }).where(eq(q.t.workItem.id, itemId)),
    );
    expect(await epicTables(db)).toEqual([]);
    await expect(db.run((q) => readyItemsSteps(q, target))).rejects.toThrow(
      /Dependency workspace or task ownership changed/,
    );
    await expect(reconciler.reconcile(target)).rejects.toThrow(
      /Item reconciliation authority changed/,
    );
  } finally {
    await reconciler.close();
    await close();
  }
});

test("a sub-issue of a delegated parent reads its parent issue from parent_delegation", async () => {
  const { db, close } = await tempStore();
  const tracker = createFakeTracker([
    {
      linearIssueId: "child-issue",
      identifier: "PRJ-2",
      title: "Child",
      description: null,
      subIssues: [],
    },
  ]);
  const lifecycle = createFakeLinearIssueLifecycle({
    id: "child-issue",
    teamId: "team",
    stateType: "started",
    assigneeId: null,
    delegateId: null,
  });
  const seen: string[] = [];
  const listDeps = tracker.listDeps.bind(tracker);
  tracker.listDeps = async (id) => {
    seen.push(id);
    return listDeps(id);
  };
  try {
    const intake = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "child-issue",
      now: 1000,
    });
    expect(intake.ok).toBe(true);
    if (!intake.ok) return;
    await install(db, intake.delegation.id);
    await seed(
      db,
      (q) =>
        q.orm.insert(q.t.parentDelegation).values({
          delegationId: "adopted",
          workspaceId: "workspace",
          organizationId: "org",
          parentIssueId: "parent-issue",
          parentIdentifier: "PRJ-1",
          title: "Parent",
          sessionId: "parent-session",
          ownerUserId: "person",
          edges: [],
          createdAt: 1000,
        }),
      (q) =>
        q.orm.insert(q.t.parentDelegationIssue).values({
          parentDelegationId: "adopted",
          workspaceId: "workspace",
          issueId: "child-issue",
          identifier: "PRJ-2",
          title: "Child",
          position: 0,
          delegationId: intake.delegation.id,
        }),
    );
    seen.length = 0;
    await syncItemDependencies(db, {
      itemId: intake.items[0]!.id,
      workspaceId: "workspace",
      expectedGeneration: 0,
      tracker,
      lifecycle,
    });
    expect(seen).toEqual(["parent-issue", "child-issue"]);
  } finally {
    await close();
  }
});

test("the scheduler admits an item without reading the epic table", async () => {
  const { db, close } = await tempStore();
  const tracker = createFakeTracker([issue]);
  try {
    const intake = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "only",
      now: 1,
    });
    expect(intake.ok).toBe(true);
    if (!intake.ok) return;
    expect(await epicTables(db)).toEqual([]);
    expect(
      await workspaceDispatchPg(db, {
        now: 2,
      }),
    ).toEqual([intake.items[0]!.id]);
  } finally {
    await close();
  }
});
