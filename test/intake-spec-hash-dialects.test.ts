import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  bindLinearSessionTask,
  listReconciliationItemsSteps,
  recordLinearInstallation,
} from "../src/db";
import { createItemReconciler, intakeDelegatedIssue, type ItemChanges } from "../src/intake";
import { createFakeLinearIssueLifecycle, createFakeTracker } from "../src/linear";
import { forEachDialect, seed, type DialectDb } from "./dialects";

function reversed(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, entry]) => [key, reversed(entry)]),
  );
}

async function delegated(connect: () => Promise<DialectDb>, reorder: boolean) {
  const handle = await connect();
  const { db } = handle;
  const tracker = createFakeTracker([
    {
      linearIssueId: "parent",
      identifier: "HASH-1",
      title: "Parent",
      description: "Parent instructions",
      subIssues: [
        { linearIssueId: "a", identifier: "HASH-2", title: "A", description: "Criteria" },
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
  lifecycle.issues.set("a", { ...lifecycle.issue, id: "a" });
  const intake = await intakeDelegatedIssue(db, tracker, { linearIssueId: "parent", now: 1000 });
  if (!intake.ok) throw new Error("Intake failed");
  const itemId = intake.items[0]!.id;
  await seed(db, (q) =>
    q.orm
      .insert(q.t.workspace)
      .values({ id: "workspace", linearOrganizationId: "org", name: "Workspace", createdAt: 1000 }),
  );
  await recordLinearInstallation(db, {
    organizationId: "org",
    oauthClientId: "client",
    appUserId: "app",
    sessionId: "session",
    teamId: "team",
    observedAtMs: 1000,
  });
  await bindLinearSessionTask(db, "session", intake.delegation.id, { actorId: "human" });
  const items = () => db.run((q) => listReconciliationItemsSteps(q, intake.delegation.id));
  if (reorder) {
    const brief = reversed(JSON.parse((await items())[0]!.brief!));
    await seed(db, (q) =>
      q.orm
        .update(q.t.workItem)
        .set({ brief: db.dialect === "sqlite" ? JSON.stringify(brief) : brief })
        .where(eq(q.t.workItem.id, itemId)),
    );
  }
  const recorded: ItemChanges[] = [];
  const reconciler = createItemReconciler({
    store: db,
    tracker,
    lifecycle,
    *onChanges(_q, changes) {
      yield* [];
      recorded.push(structuredClone(changes));
    },
  });
  const reconcile = () => reconciler.reconcile({ itemId, workspaceId: "workspace" });
  return { handle, tracker, itemId, items, recorded, reconcile };
}

forEachDialect((connect) => {
  test("an unchanged brief with its keys reordered is not a spec change", async () => {
    const { handle, itemId, items, recorded, reconcile } = await delegated(connect, true);
    try {
      expect((await items())[0]).toMatchObject({ id: itemId, hash: null });
      await reconcile();
      expect(recorded[0]!.specChangedItemIds).toEqual([]);
      expect((await items())[0]).toMatchObject({ id: itemId, revision: 1, present: 1 });
    } finally {
      await handle.close();
    }
  });

  test("a removed item records the same hash whatever order its brief's keys come back in", async () => {
    const hashes: (string | null)[] = [];
    for (const reorder of [false, true]) {
      const { handle, tracker, items, reconcile } = await delegated(connect, reorder);
      try {
        tracker.epics.get("parent")!.subIssues = [];
        await reconcile();
        const [item] = await items();
        expect(item).toMatchObject({ present: 0 });
        hashes.push(item!.hash);
      } finally {
        await handle.close();
      }
    }
    expect(hashes[0]).toHaveLength(64);
    expect(hashes[1]).toBe(hashes[0]!);
  });
});
