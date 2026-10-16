import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindLinearSessionTask, listTaskBlockers, recordLinearInstallation } from "../src/db";
import { intakeDelegatedIssue, readyItems, syncEpicDependencies } from "../src/intake";
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
  const target = { epicId: intake.epic.id, workspaceId: "workspace" };
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
  bindLinearSessionTask(db, "session", intake.epic.id, { actorId: "owner" });
  const refresh = () =>
    syncEpicDependencies(db, {
      ...target,
      expectedGeneration: readyItems(db, target).generation,
      tracker,
      lifecycle,
    });
  return { db, tracker, lifecycle, target, ids, refresh };
}

test("sync stores internal and external edges in task_block and readiness matches", async () => {
  const { db, tracker, lifecycle, target, ids, refresh } = await dependencyEpic();
  try {
    tracker.deps.set("parent", [
      { blockerLinearIssueId: "a", blockedLinearIssueId: "b" },
      { blockerLinearIssueId: "outside", blockedLinearIssueId: "b" },
      { blockerLinearIssueId: "a", blockedLinearIssueId: "outside" },
    ]);
    await refresh();
    expect(count(db, "work_item_block")).toBe(1);
    expect(count(db, "external_dep")).toBe(1);
    expect(listTaskBlockers(db, "b")).toEqual(["a", "outside"]);
    expect(listTaskBlockers(db, "outside")).toEqual([]);
    const ready = () => readyItems(db, target).readyItemIds;
    expect(ready()).not.toContain(ids.get("b")!);
    expect(ready()).toContain(ids.get("a")!);
    db.run("UPDATE work_item SET state = 'merged' WHERE id = ?", [ids.get("a")!]);
    expect(ready()).toContain(ids.get("b")!);
    lifecycle.issues.get("outside")!.stateType = "started";
    await refresh();
    expect(ready()).not.toContain(ids.get("b")!);
    expect(listTaskBlockers(db, "b")).toEqual(["a", "outside"]);
  } finally {
    db.close();
  }
});

test("a blocker stored only in task_block holds the dependent", async () => {
  const { db, target, ids, refresh } = await dependencyEpic();
  try {
    await refresh();
    expect(readyItems(db, target).readyItemIds.sort()).toEqual(
      [ids.get("a")!, ids.get("b")!].sort(),
    );
    expect(count(db, "work_item_block")).toBe(0);
    expect(count(db, "external_dep")).toBe(0);
    db.run(
      "INSERT INTO task_block(blocker_linear_issue_id, blocked_linear_issue_id) VALUES('a', 'b')",
    );
    const ready = readyItems(db, target).readyItemIds;
    expect(ready).toContain(ids.get("a")!);
    expect(ready).not.toContain(ids.get("b")!);
    expect(count(db, "work_item_block")).toBe(0);
    expect(count(db, "external_dep")).toBe(0);
  } finally {
    db.close();
  }
});
