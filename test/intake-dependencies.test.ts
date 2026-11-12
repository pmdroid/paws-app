import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bindLinearSessionTask,
  listTaskBlockers,
  recordLinearInstallation,
  type Db,
} from "../src/db";
import { intakeDelegatedIssue, readyItemsSteps, syncItemDependencies } from "../src/intake";
import { createFakeLinearIssueLifecycle, createFakeTracker } from "../src/linear";
import { seed } from "./dialects";
import { confirmFakeMergePg } from "./fake-workspace";
import { tempStore } from "./pglite";
import { probeDependencySnapshots } from "./local/intake-dependencies";

test("Authoritative dependency snapshots preserve workspace and generation fences", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-dependencies-"));
  const names: string[] = [];
  try {
    await probeDependencySnapshots(root, (name, passed) => {
      assert(passed, name);
      names.push(name);
    });
    assert.equal(names.length, 10);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function count(db: Db, table: "taskBlock" | "itemDependencySnapshot"): Promise<number> {
  return (await db.run((q) => q.all(q.orm.select().from(q.t[table])))).length;
}

function workspace(db: Db) {
  return seed(db, (q) =>
    q.orm
      .insert(q.t.workspace)
      .values({ id: "workspace", linearOrganizationId: "org", name: "Workspace", createdAt: 1000 }),
  );
}

async function dependencyEpic() {
  const { db, close } = await tempStore();
  const tracker = createFakeTracker([
    {
      linearIssueId: "parent",
      identifier: "DEP-1",
      title: "Parent",
      description: null,
      subIssues: ["a", "b"].map((id, index) => ({
        linearIssueId: id,
        identifier: `DEP-${index + 2}`,
        title: id,
      })),
    },
  ]);
  const lifecycle = createFakeLinearIssueLifecycle({
    id: "a",
    teamId: "team",
    stateType: "started",
    assigneeId: null,
    delegateId: null,
  });
  lifecycle.issues.set("outside", { ...lifecycle.issue, id: "outside", stateType: "completed" });
  const intake = await intakeDelegatedIssue(db, tracker, {
    linearIssueId: "parent",
    now: 1000,
  });
  if (!intake.ok) throw new Error("Intake failed");
  const workspaceId = "workspace";
  const ids = new Map(intake.items.map((item) => [item.linearIssueId, item.id]));
  await workspace(db);
  await recordLinearInstallation(db, {
    organizationId: "org",
    oauthClientId: "client",
    appUserId: "app",
    sessionId: "session",
    teamId: "team",
    observedAtMs: 1000,
  });
  await bindLinearSessionTask(db, "session", intake.delegation.id, { actorId: "owner" });
  const readyIds = async () => {
    const ready: string[] = [];
    for (const item of intake.items)
      ready.push(
        ...(await db.run((q) => readyItemsSteps(q, { itemId: item.id, workspaceId }))).readyItemIds,
      );
    return ready;
  };
  const refresh = async () => {
    for (const item of intake.items)
      await syncItemDependencies(db, {
        itemId: item.id,
        workspaceId,
        expectedGeneration: (
          await db.run((q) => readyItemsSteps(q, { itemId: item.id, workspaceId }))
        ).generation,
        tracker,
        lifecycle,
      });
  };
  return { db, close, tracker, lifecycle, ids, refresh, readyIds, workspaceId };
}

test("sync stores internal and external edges in task_block and readiness matches", async () => {
  const { db, close, tracker, lifecycle, ids, refresh, readyIds } = await dependencyEpic();
  try {
    tracker.deps.set("parent", [
      { blockerLinearIssueId: "a", blockedLinearIssueId: "b" },
      { blockerLinearIssueId: "outside", blockedLinearIssueId: "b" },
      { blockerLinearIssueId: "a", blockedLinearIssueId: "outside" },
    ]);
    await refresh();
    expect(await count(db, "taskBlock")).toBe(2);
    expect(await listTaskBlockers(db, "b")).toEqual(["a", "outside"]);
    expect(await listTaskBlockers(db, "outside")).toEqual([]);
    expect(await readyIds()).not.toContain(ids.get("b")!);
    expect(await readyIds()).toContain(ids.get("a")!);
    await seed(db, (q) =>
      q.orm
        .update(q.t.workItem)
        .set({ state: "merged" })
        .where(eq(q.t.workItem.id, ids.get("a")!)),
    );
    expect(await readyIds()).not.toContain(ids.get("b")!);
    await confirmFakeMergePg(db, ids.get("a")!);
    expect(await readyIds()).toContain(ids.get("b")!);
    lifecycle.issues.get("outside")!.stateType = "started";
    await refresh();
    expect(await readyIds()).not.toContain(ids.get("b")!);
    expect(await listTaskBlockers(db, "b")).toEqual(["a", "outside"]);
  } finally {
    await close();
  }
});

test("a blocker stored only in task_block holds the dependent", async () => {
  const { db, close, ids, refresh, readyIds } = await dependencyEpic();
  try {
    await refresh();
    expect((await readyIds()).sort()).toEqual([ids.get("a")!, ids.get("b")!].sort());
    expect(await count(db, "taskBlock")).toBe(0);
    await seed(db, (q) =>
      q.orm.insert(q.t.taskBlock).values({ blockerLinearIssueId: "a", blockedLinearIssueId: "b" }),
    );
    const ready = await readyIds();
    expect(ready).toContain(ids.get("a")!);
    expect(ready).not.toContain(ids.get("b")!);
    expect(await count(db, "taskBlock")).toBe(1);
  } finally {
    await close();
  }
});

test("an item with a satisfied and an unsatisfied external blocker stays held", async () => {
  const { db, close } = await tempStore();
  const tracker = createFakeTracker([
    {
      linearIssueId: "item",
      identifier: "DEP-1",
      title: "Item",
      description: null,
      subIssues: [],
    },
  ]);
  const lifecycle = createFakeLinearIssueLifecycle({
    id: "done",
    teamId: "team",
    stateType: "completed",
    assigneeId: null,
    delegateId: null,
  });
  lifecycle.issues.set("open", { ...lifecycle.issue, id: "open", stateType: "started" });
  try {
    const intake = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "item",
      now: 1000,
    });
    if (!intake.ok) throw new Error("Intake failed");
    const itemId = intake.items[0]!.id;
    const target = { itemId, workspaceId: "workspace" };
    await workspace(db);
    await recordLinearInstallation(db, {
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      sessionId: "session",
      teamId: "team",
      observedAtMs: 1000,
    });
    await bindLinearSessionTask(db, "session", intake.delegation.id, {
      actorId: "owner",
    });
    tracker.deps.set("item", [
      { blockerLinearIssueId: "done", blockedLinearIssueId: "item" },
      { blockerLinearIssueId: "open", blockedLinearIssueId: "item" },
    ]);
    const refresh = async () =>
      syncItemDependencies(db, {
        ...target,
        expectedGeneration: (await db.run((q) => readyItemsSteps(q, target))).generation,
        tracker,
        lifecycle,
      });
    await refresh();
    expect((await db.run((q) => readyItemsSteps(q, target))).readyItemIds).toEqual([]);
    expect(await count(db, "itemDependencySnapshot")).toBe(1);
    lifecycle.issues.get("open")!.stateType = "completed";
    await refresh();
    expect((await db.run((q) => readyItemsSteps(q, target))).readyItemIds).toEqual([itemId]);
  } finally {
    await close();
  }
});

test("a stale dependency sync is rejected", async () => {
  const { db, close, tracker, lifecycle, ids, refresh, workspaceId } = await dependencyEpic();
  try {
    await refresh();
    const itemId = ids.get("a")!;
    const target = { itemId, workspaceId };
    const generation = (await db.run((q) => readyItemsSteps(q, target))).generation;
    await expect(
      syncItemDependencies(db, {
        ...target,
        expectedGeneration: generation - 1,
        tracker,
        lifecycle,
      }),
    ).rejects.toThrow(/snapshot changed/);
    expect((await db.run((q) => readyItemsSteps(q, target))).generation).toBe(generation);
  } finally {
    await close();
  }
});

test("a held item tells Linear which blockers it waits for, once", async () => {
  const { db, close } = await tempStore();
  const tracker = createFakeTracker([
    { linearIssueId: "item", identifier: "DEP-1", title: "Item", description: null, subIssues: [] },
  ]);
  const lifecycle = createFakeLinearIssueLifecycle({
    id: "done",
    identifier: "DEP-2",
    teamId: "team",
    stateType: "completed",
    assigneeId: null,
    delegateId: null,
  });
  lifecycle.issues.set("open", {
    ...lifecycle.issue,
    id: "open",
    identifier: "DEP-3",
    stateType: "started",
  });
  try {
    const intake = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "item",
      now: 1000,
    });
    if (!intake.ok) throw new Error("Intake failed");
    const target = { itemId: intake.items[0]!.id, workspaceId: "workspace" };
    await workspace(db);
    await recordLinearInstallation(db, {
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      sessionId: "session",
      teamId: "team",
      observedAtMs: 1000,
    });
    await bindLinearSessionTask(db, "session", intake.delegation.id, {
      actorId: "owner",
    });
    tracker.deps.set("item", [
      { blockerLinearIssueId: "done", blockedLinearIssueId: "item" },
      { blockerLinearIssueId: "open", blockedLinearIssueId: "item" },
    ]);
    const refresh = async () =>
      syncItemDependencies(db, {
        ...target,
        expectedGeneration: (await db.run((q) => readyItemsSteps(q, target))).generation,
        tracker,
        lifecycle,
      });
    await refresh();
    await refresh();
    const waiting = (
      await db.run((q) =>
        q.all(
          q.orm
            .select({ payload: q.t.outbox.payload })
            .from(q.t.outbox)
            .where(eq(q.t.outbox.op, "activity")),
        ),
      )
    ).map((row) => (typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload));
    expect(waiting).toEqual([
      { sessionId: "session", kind: "thought", body: "Waiting for DEP-3 before starting." },
    ]);
  } finally {
    await close();
  }
});
