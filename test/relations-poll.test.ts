import { expect, test } from "bun:test";
import {
  bindLinearSessionTask,
  listTaskBlockers,
  migrate,
  openDatabase,
  recordLinearInstallation,
} from "../src/db";
import { createItemReconciler, intakeDelegatedIssue } from "../src/intake";
import { createFakeLinearIssueLifecycle, createFakeTracker } from "../src/linear";

async function relationsFixture() {
  const db = openDatabase(":memory:");
  migrate(db);
  const tracker = createFakeTracker([
    {
      linearIssueId: "parent",
      identifier: "REL-1",
      title: "Parent",
      description: null,
      subIssues: [{ linearIssueId: "child", identifier: "REL-2", title: "Child" }],
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
  lifecycle.issues.set("outside", { ...lifecycle.issue, id: "outside", stateType: "started" });
  const intake = await intakeDelegatedIssue(db, tracker, { linearIssueId: "parent", now: 1000 });
  if (!intake.ok) throw new Error("intake failed");
  db.run("INSERT INTO workspace VALUES('workspace','org','Workspace',1000)");
  recordLinearInstallation(db, {
    organizationId: "org",
    oauthClientId: "client",
    appUserId: "app",
    sessionId: "session",
    teamId: "team",
    observedAtMs: 1000,
  });
  bindLinearSessionTask(db, "session", intake.delegation.id, { actorId: "human" });
  let epicReads = 0;
  const depReads: string[] = [];
  const reconciler = createItemReconciler({
    db,
    tracker: {
      ...tracker,
      async listDeps(id) {
        depReads.push(id);
        return tracker.listDeps(id);
      },
      async loadEpic(id) {
        epicReads++;
        return tracker.loadEpic(id);
      },
    },
    lifecycle,
    onChanges() {},
    now: () => 10_000,
  });
  await reconciler.sweep({ now: 10_000 });
  return {
    db,
    tracker,
    reconciler,
    epicReads: () => epicReads,
    depReads,
    async [Symbol.asyncDispose]() {
      await reconciler.close();
      db.close();
    },
  };
}

test("a relations poll with no relation change reads only relations", async () => {
  await using fixture = await relationsFixture();
  fixture.depReads.length = 0;
  expect(await fixture.reconciler.pollRelations()).toEqual([]);
  expect(fixture.epicReads()).toBe(1);
  expect(fixture.depReads).toEqual(["child"]);
});

test("a relations poll picks up a blocker added in Linear and reconciles its delegation", async () => {
  await using fixture = await relationsFixture();
  expect(listTaskBlockers(fixture.db, "child")).toEqual([]);
  fixture.tracker.deps.set("child", [
    { blockerLinearIssueId: "outside", blockedLinearIssueId: "child" },
  ]);
  const changed = await fixture.reconciler.pollRelations();
  expect(changed).toHaveLength(1);
  expect(fixture.epicReads()).toBe(2);
  expect(listTaskBlockers(fixture.db, "child")).toEqual(["outside"]);
  expect(await fixture.reconciler.pollRelations()).toEqual([]);
  expect(fixture.epicReads()).toBe(2);
});

test("a relations poll picks up a blocker removed in Linear", async () => {
  await using fixture = await relationsFixture();
  fixture.tracker.deps.set("child", [
    { blockerLinearIssueId: "outside", blockedLinearIssueId: "child" },
  ]);
  await fixture.reconciler.pollRelations();
  expect(listTaskBlockers(fixture.db, "child")).toEqual(["outside"]);
  fixture.tracker.deps.set("child", []);
  expect(await fixture.reconciler.pollRelations()).toHaveLength(1);
  expect(listTaskBlockers(fixture.db, "child")).toEqual([]);
});

test("a relation where the item blocks another issue does not count as its blocker", async () => {
  await using fixture = await relationsFixture();
  fixture.tracker.deps.set("child", [
    { blockerLinearIssueId: "child", blockedLinearIssueId: "outside" },
  ]);
  expect(await fixture.reconciler.pollRelations()).toEqual([]);
  expect(fixture.epicReads()).toBe(1);
});
