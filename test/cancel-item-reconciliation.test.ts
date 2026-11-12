import assert from "node:assert/strict";
import { test } from "bun:test";
import { eq } from "drizzle-orm";
import { applyWorkItemEvent, type Db } from "../src/db";
import { hasPendingDelegationChanges } from "../src/intake";
import { seed as insert } from "./dialects";
import { tempStore } from "./pglite";

function item(db: Db, id: string, state: string) {
  return insert(db, (q) =>
    q.orm.insert(q.t.workItem).values({
      id,
      delegationId: "delegation",
      linearIssueId: `issue-${id}`,
      linearIdentifier: id,
      title: id,
      state,
      branchName: `paws/${id}`,
      position: 0,
      createdAt: 0,
    }),
  );
}

async function reconciliationRows(db: Db, id: string) {
  return await db.run(function* (q) {
    const { itemReconciliationRequest: request, itemReconciliationEffect: effect } = q.t;
    const requests = yield* q.all(q.orm.select().from(request).where(eq(request.itemId, id)));
    const effects = yield* q.all(q.orm.select().from(effect).where(eq(effect.itemId, id)));
    return { requests: requests.length, effects: effects.length };
  });
}

async function seed(db: Db) {
  await insert(db, (q) =>
    q.orm
      .insert(q.t.workspace)
      .values({ id: "workspace", linearOrganizationId: "org", name: "Workspace", createdAt: 0 }),
  );
  await item(db, "cancelled", "running");
  await item(db, "live", "queued");
  for (const id of ["cancelled", "live"])
    await insert(db, (q) =>
      q.orm
        .insert(q.t.itemReconciliationRequest)
        .values({ itemId: id, workspaceId: "workspace", token: "token" }),
    );
}

test("cancelling an item with a pending request leaves no reconciliation rows for it", async () => {
  const { db, close } = await tempStore();
  try {
    await seed(db);
    await applyWorkItemEvent(db, "cancelled", "cancel");
    assert.deepEqual(await reconciliationRows(db, "cancelled"), { requests: 0, effects: 0 });
    assert.deepEqual(await reconciliationRows(db, "live"), { requests: 1, effects: 0 });
  } finally {
    await close();
  }
});

test("the delegation of a cancelled item is no longer held as reconciling", async () => {
  const { db, close } = await tempStore();
  try {
    await seed(db);
    await insert(db, (q) =>
      q.orm
        .delete(q.t.itemReconciliationRequest)
        .where(eq(q.t.itemReconciliationRequest.itemId, "live")),
    );
    assert.equal(await hasPendingDelegationChanges(db, "delegation"), true);
    await applyWorkItemEvent(db, "cancelled", "cancel");
    assert.equal(await hasPendingDelegationChanges(db, "delegation"), false);
  } finally {
    await close();
  }
});

test("cancelling an item keeps the effects a running reconcile still publishes", async () => {
  const { db, close } = await tempStore();
  try {
    await seed(db);
    for (const kind of ["spec", "removed", "canceled"])
      await insert(db, (q) =>
        q.orm
          .insert(q.t.itemReconciliationEffect)
          .values({ itemId: "cancelled", kind, token: "token" }),
      );
    await applyWorkItemEvent(db, "cancelled", "cancel");
    assert.deepEqual(await reconciliationRows(db, "cancelled"), { requests: 0, effects: 3 });
  } finally {
    await close();
  }
});
