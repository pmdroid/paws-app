import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindLinearSessionTask, listTaskBlockers, recordLinearInstallation } from "../src/db";
import { intakeDelegatedIssue, readyItems, syncItemDependencies } from "../src/intake";
import { createFakeLinearIssueLifecycle, createFakeTracker } from "../src/linear";
import { tempDb } from "./helpers";
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

function count(db: Database, table: string): number {
  return db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;
}

async function dependencyEpic() {
  const db = tempDb();
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
  const intake = await intakeDelegatedIssue(db, tracker, { linearIssueId: "parent", now: 1000 });
  if (!intake.ok) throw new Error("Intake failed");
  const workspaceId = "workspace";
  const ids = new Map(intake.items.map((item) => [item.linearIssueId, item.id]));
  db.run("INSERT INTO workspace VALUES('workspace','org','Workspace',1000)");
  recordLinearInstallation(db, {
    organizationId: "org",
    oauthClientId: "client",
    appUserId: "app",
    sessionId: "session",
    teamId: "team",
    observedAtMs: 1000,
  });
  bindLinearSessionTask(db, "session", intake.delegation.id, { actorId: "owner" });
  const readyIds = () =>
    intake.items.flatMap((item) => readyItems(db, { itemId: item.id, workspaceId }).readyItemIds);
  const refresh = async () => {
    for (const item of intake.items)
      await syncItemDependencies(db, {
        itemId: item.id,
        workspaceId,
        expectedGeneration: readyItems(db, { itemId: item.id, workspaceId }).generation,
        tracker,
        lifecycle,
      });
  };
  return { db, tracker, lifecycle, ids, refresh, readyIds, workspaceId };
}

test("sync stores internal and external edges in task_block and readiness matches", async () => {
  const { db, tracker, lifecycle, ids, refresh, readyIds } = await dependencyEpic();
  try {
    tracker.deps.set("parent", [
      { blockerLinearIssueId: "a", blockedLinearIssueId: "b" },
      { blockerLinearIssueId: "outside", blockedLinearIssueId: "b" },
      { blockerLinearIssueId: "a", blockedLinearIssueId: "outside" },
    ]);
    await refresh();
    expect(count(db, "task_block")).toBe(2);
    expect(listTaskBlockers(db, "b")).toEqual(["a", "outside"]);
    expect(listTaskBlockers(db, "outside")).toEqual([]);
    expect(readyIds()).not.toContain(ids.get("b")!);
    expect(readyIds()).toContain(ids.get("a")!);
    db.run("UPDATE work_item SET state = 'merged' WHERE id = ?", [ids.get("a")!]);
    expect(readyIds()).toContain(ids.get("b")!);
    lifecycle.issues.get("outside")!.stateType = "started";
    await refresh();
    expect(readyIds()).not.toContain(ids.get("b")!);
    expect(listTaskBlockers(db, "b")).toEqual(["a", "outside"]);
  } finally {
    db.close();
  }
});

test("a blocker stored only in task_block holds the dependent", async () => {
  const { db, ids, refresh, readyIds } = await dependencyEpic();
  try {
    await refresh();
    expect(readyIds().sort()).toEqual([ids.get("a")!, ids.get("b")!].sort());
    expect(count(db, "task_block")).toBe(0);
    db.run(
      "INSERT INTO task_block(blocker_linear_issue_id, blocked_linear_issue_id) VALUES('a', 'b')",
    );
    const ready = readyIds();
    expect(ready).toContain(ids.get("a")!);
    expect(ready).not.toContain(ids.get("b")!);
    expect(count(db, "task_block")).toBe(1);
  } finally {
    db.close();
  }
});

test("an item with a satisfied and an unsatisfied external blocker stays held", async () => {
  const db = tempDb();
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
    const intake = await intakeDelegatedIssue(db, tracker, { linearIssueId: "item", now: 1000 });
    if (!intake.ok) throw new Error("Intake failed");
    const itemId = intake.items[0]!.id;
    const target = { itemId, workspaceId: "workspace" };
    db.run("INSERT INTO workspace VALUES('workspace','org','Workspace',1000)");
    recordLinearInstallation(db, {
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      sessionId: "session",
      teamId: "team",
      observedAtMs: 1000,
    });
    bindLinearSessionTask(db, "session", intake.delegation.id, { actorId: "owner" });
    tracker.deps.set("item", [
      { blockerLinearIssueId: "done", blockedLinearIssueId: "item" },
      { blockerLinearIssueId: "open", blockedLinearIssueId: "item" },
    ]);
    const refresh = () =>
      syncItemDependencies(db, {
        ...target,
        expectedGeneration: readyItems(db, target).generation,
        tracker,
        lifecycle,
      });
    await refresh();
    expect(readyItems(db, target).readyItemIds).toEqual([]);
    expect(
      db
        .query(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'epic_dependency_snapshot'",
        )
        .get(),
    ).toBeNull();
    expect(count(db, "item_dependency_snapshot")).toBe(1);
    lifecycle.issues.get("open")!.stateType = "completed";
    await refresh();
    expect(readyItems(db, target).readyItemIds).toEqual([itemId]);
  } finally {
    db.close();
  }
});

test("a stale dependency sync is rejected", async () => {
  const { db, tracker, lifecycle, ids, refresh, workspaceId } = await dependencyEpic();
  try {
    await refresh();
    const itemId = ids.get("a")!;
    const target = { itemId, workspaceId };
    const generation = readyItems(db, target).generation;
    await expect(
      syncItemDependencies(db, {
        ...target,
        expectedGeneration: generation - 1,
        tracker,
        lifecycle,
      }),
    ).rejects.toThrow(/snapshot changed/);
    expect(readyItems(db, target).generation).toBe(generation);
  } finally {
    db.close();
  }
});

test("a held item tells Linear which blockers it waits for, once", async () => {
  const db = tempDb();
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
    const intake = await intakeDelegatedIssue(db, tracker, { linearIssueId: "item", now: 1000 });
    if (!intake.ok) throw new Error("Intake failed");
    const target = { itemId: intake.items[0]!.id, workspaceId: "workspace" };
    db.run("INSERT INTO workspace VALUES('workspace','org','Workspace',1000)");
    recordLinearInstallation(db, {
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      sessionId: "session",
      teamId: "team",
      observedAtMs: 1000,
    });
    bindLinearSessionTask(db, "session", intake.epic.id, { actorId: "owner" });
    tracker.deps.set("item", [
      { blockerLinearIssueId: "done", blockedLinearIssueId: "item" },
      { blockerLinearIssueId: "open", blockedLinearIssueId: "item" },
    ]);
    const refresh = () =>
      syncItemDependencies(db, {
        ...target,
        expectedGeneration: readyItems(db, target).generation,
        tracker,
        lifecycle,
      });
    await refresh();
    await refresh();
    const waiting = db
      .query<{ payload: string }, []>("SELECT payload FROM outbox WHERE op='activity'")
      .all()
      .map((row) => JSON.parse(row.payload) as { sessionId: string; kind: string; body: string });
    expect(waiting).toEqual([
      { sessionId: "session", kind: "thought", body: "Waiting for DEP-3 before starting." },
    ]);
  } finally {
    db.close();
  }
});
