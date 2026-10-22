import { expect, test } from "bun:test";
import { bindLinearSessionTask, migrate, openDatabase, recordLinearInstallation } from "../src/db";
import { createItemReconciler, intakeDelegatedIssue, SWEEP_FULL_REFRESH_MS } from "../src/intake";
import { createFakeLinearIssueLifecycle, createFakeTracker } from "../src/linear";

async function sweepFixture() {
  const db = openDatabase(":memory:");
  migrate(db);
  const tracker = createFakeTracker([
    {
      linearIssueId: "parent",
      identifier: "SYNC-1",
      title: "Parent",
      description: null,
      subIssues: [{ linearIssueId: "child", identifier: "SYNC-2", title: "Child" }],
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
  let clock = 10_000;
  let reads = 0;
  let failNext = false;
  const reconciler = createItemReconciler({
    db,
    tracker: {
      ...tracker,
      listDeps: tracker.listDeps.bind(tracker),
      async loadEpic(id) {
        reads++;
        if (failNext) {
          failNext = false;
          throw new Error("Linear unavailable");
        }
        return tracker.loadEpic(id);
      },
    },
    lifecycle,
    onChanges() {},
    now: () => clock,
  });
  return {
    db,
    reconciler,
    reads: () => reads,
    failNextRead() {
      failNext = true;
    },
    advance(ms: number) {
      clock += ms;
      return clock;
    },
  };
}

test("a sweep right after another with no Linear change reads nothing", async () => {
  const fixture = await sweepFixture();
  try {
    await fixture.reconciler.sweep({ now: fixture.advance(0) });
    expect(fixture.reads()).toBe(1);
    await fixture.reconciler.sweep({ now: fixture.advance(30 * 60_000) });
    expect(fixture.reads()).toBe(1);
  } finally {
    await fixture.reconciler.close();
    fixture.db.close();
  }
});

test("a sweep re-reads a delegation whose issue change was not reconciled", async () => {
  const fixture = await sweepFixture();
  try {
    await fixture.reconciler.sweep({ now: fixture.advance(0) });
    fixture.failNextRead();
    await expect(
      fixture.reconciler.issueChanged({ issueId: "child", organizationId: "org" }),
    ).rejects.toThrow("Linear unavailable");
    expect(fixture.reads()).toBe(2);
    await fixture.reconciler.sweep({ now: fixture.advance(30 * 60_000) });
    expect(fixture.reads()).toBe(3);
    await fixture.reconciler.sweep({ now: fixture.advance(30 * 60_000) });
    expect(fixture.reads()).toBe(3);
  } finally {
    await fixture.reconciler.close();
    fixture.db.close();
  }
});

test("a sweep re-reads a delegation untouched for longer than the full refresh window", async () => {
  const fixture = await sweepFixture();
  try {
    await fixture.reconciler.sweep({ now: fixture.advance(0) });
    await fixture.reconciler.sweep({ now: fixture.advance(SWEEP_FULL_REFRESH_MS - 1) });
    expect(fixture.reads()).toBe(1);
    await fixture.reconciler.sweep({ now: fixture.advance(1) });
    expect(fixture.reads()).toBe(2);
  } finally {
    await fixture.reconciler.close();
    fixture.db.close();
  }
});
