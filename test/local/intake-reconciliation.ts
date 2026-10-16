import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyWorkItemEvent,
  bindLinearSessionTask,
  migrate,
  openDatabase,
  recordLinearInstallation,
  saveTaskMode,
} from "../../src/db";
import {
  createEpicReconciler,
  intakeDelegatedIssue,
  readyItems,
  type EpicChanges,
} from "../../src/intake";
import { createFakeLinearIssueLifecycle, createFakeTracker } from "../../src/linear";

export async function probeEpicReconciliation(root: string) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const db = openDatabase(join(root, "paws.sqlite"));
  migrate(db);
  const tracker = createFakeTracker([
    {
      linearIssueId: "parent",
      identifier: "SYNC-1",
      title: "Parent",
      description: "Parent criteria",
      subIssues: [
        { linearIssueId: "a", identifier: "SYNC-2", title: "A", description: "Original criteria" },
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
  lifecycle.issues.set("b", { ...lifecycle.issue, id: "b" });
  lifecycle.issues.set("outside", { ...lifecycle.issue, id: "outside", stateType: "started" });
  const observations: { name: string; passed: boolean; observed: unknown }[] = [];
  const observe = (name: string, observed: unknown) =>
    observations.push({ name, passed: true, observed });
  try {
    const intake = await intakeDelegatedIssue(db, tracker, { linearIssueId: "parent", now: 1000 });
    assert(intake.ok);
    db.run("INSERT INTO workspace VALUES('workspace','org','Workspace',1000)");
    recordLinearInstallation(db, {
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      sessionId: "session",
      teamId: "team",
      observedAtMs: 1000,
    });
    bindLinearSessionTask(db, "session", intake.epic.id, { actorId: "human" });
    const target = { epicId: intake.epic.id, workspaceId: "workspace" };
    const recorded: EpicChanges[] = [];
    const joinedChanges: EpicChanges[] = [];
    let fail = false;
    const reconciler = createEpicReconciler({
      db,
      tracker,
      lifecycle,
      onChanges(changes) {
        assert(db.inTransaction);
        if (fail) throw new Error("Injected canonical effect failure");
        for (const id of changes.addedItemIds) saveTaskMode(db, id, "code", 0, true);
        for (const id of [...changes.removedItemIds, ...changes.canceledItemIds]) {
          const row = db
            .query<{ state: string }, [string]>("SELECT state FROM work_item WHERE id=?")
            .get(id)!;
          if (!["cancelled", "merged", "completed"].includes(row.state))
            applyWorkItemEvent(db, id, "cancel");
        }
        recorded.push(structuredClone(changes));
      },
      async afterChanges(changes) {
        joinedChanges.push(structuredClone(changes));
      },
    });
    await reconciler.reconcile(target);
    const specification = () =>
      db
        .query<{ hash: string; revision: number; present: number }, [string]>(
          "SELECT hash,revision,present FROM work_item_specification WHERE item_id=?",
        )
        .get(intake.items[0]!.id)!;
    assert.equal(specification().revision, 1);
    assert.equal(specification().hash.length, 64);
    assert.deepEqual(recorded[0]!.specChangedItemIds, []);
    await reconciler.reconcile(target);
    assert.equal(specification().revision, 1);
    observe(
      "Initial specifications are persisted without invalidating unchanged evidence",
      specification(),
    );
    const firstHash = specification().hash;
    tracker.epics.get("parent")!.subIssues[0]!.description = "Changed acceptance criteria";
    await reconciler.reconcile(target);
    assert.equal(specification().revision, 2);
    assert.notEqual(specification().hash, firstHash);
    assert.deepEqual(recorded.at(-1)!.specChangedItemIds, [intake.items[0]!.id]);
    tracker.epics.get("parent")!.description = "Changed parent instructions";
    await reconciler.reconcile(target);
    assert.equal(specification().revision, 3);
    observe(
      "Child and parent instruction edits produce durable specification revisions",
      recorded.at(-1),
    );
    const before = specification();
    tracker.epics.get("parent")!.subIssues[0]!.description = "Must roll back";
    fail = true;
    await assert.rejects(reconciler.reconcile(target), /Injected canonical effect failure/);
    assert.deepEqual(specification(), before);
    assert(
      !db
        .query<{ brief: string }, [string]>("SELECT brief FROM work_item WHERE id=?")
        .get(intake.items[0]!.id)!
        .brief.includes("Must roll back"),
    );
    fail = false;
    observe(
      "A failed canonical invalidation rolls back brief and specification publication",
      specification(),
    );
    let interruptedEffects: EpicChanges | null = null;
    const interrupted = createEpicReconciler({
      db,
      tracker,
      lifecycle,
      onChanges(changes) {
        interruptedEffects = structuredClone(changes);
      },
      async afterChanges() {
        throw new Error("Injected coordinator interruption before live join");
      },
    });
    await assert.rejects(interrupted.reconcile(target), /coordinator interruption/);
    assert.equal(
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM epic_reconciliation_effect").get()!.n,
      1,
    );
    assert.deepEqual(readyItems(db, target).readyItemIds, []);
    const recoveredDb = openDatabase(join(root, "paws.sqlite"));
    try {
      let recoveredEffects: EpicChanges | null = null;
      const recovered = createEpicReconciler({
        db: recoveredDb,
        tracker,
        lifecycle,
        onChanges(changes) {
          recoveredEffects = structuredClone(changes);
        },
        async afterChanges(changes) {
          assert.deepEqual(changes.specChangedItemIds, interruptedEffects!.specChangedItemIds);
        },
      });
      await recovered.reconcile(target);
      assert.deepEqual(recoveredEffects!.specChangedItemIds, []);
      assert.equal(
        recoveredDb
          .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM epic_reconciliation_effect")
          .get()!.n,
        0,
      );
      observe(
        "Interrupted live effects survive coordinator reconstruction until joined and refreshed",
        recoveredEffects,
      );
    } finally {
      recoveredDb.close();
    }
    const loadDependencies = tracker.listDeps.bind(tracker);
    tracker.listDeps = async (id) => {
      if (
        id !== "parent" &&
        !tracker.epics.get("parent")!.subIssues.some((issue) => issue.linearIssueId === id)
      )
        throw new Error("Deleted Linear child is not available");
      return loadDependencies(id);
    };
    tracker.epics.get("parent")!.subIssues = [
      { linearIssueId: "b", identifier: "SYNC-3", title: "B" },
    ];
    await reconciler.issueChanged({ issueId: "b", organizationId: "org", parentIssueId: "parent" });
    assert.deepEqual(recorded.at(-1)!.removedItemIds, [intake.items[0]!.id]);
    assert.equal(recorded.at(-1)!.addedItemIds.length, 1);
    const b = recorded.at(-1)!.addedItemIds[0]!;
    assert.equal(specification().present, 0);
    assert.equal(
      db
        .query<{ state: string }, [string]>("SELECT state FROM work_item WHERE id=?")
        .get(intake.items[0]!.id)!.state,
      "cancelled",
    );
    assert.equal(
      db
        .query<{ mode: string }, [string]>("SELECT mode FROM work_item_task WHERE item_id=?")
        .get(b)!.mode,
      "code",
    );
    observe(
      "Child replacement queues new code work and canonically cancels removed history",
      recorded.at(-1),
    );
    tracker.deps.set("parent", [{ blockerLinearIssueId: "outside", blockedLinearIssueId: "b" }]);
    await reconciler.reconcile(target);
    assert.deepEqual(readyItems(db, target).readyItemIds, []);
    lifecycle.issues.get("outside")!.stateType = "completed";
    const beforeWrong = recorded.length;
    await reconciler.issueChanged({ issueId: "outside", organizationId: "other" });
    assert.equal(recorded.length, beforeWrong);
    await reconciler.issueChanged({ issueId: "outside", organizationId: "org" });
    assert.deepEqual(readyItems(db, target).readyItemIds, [b]);
    observe(
      "External blocker events resync only matching organization epics",
      readyItems(db, target),
    );
    const beforeSweep = recorded.length;
    await reconciler.sweep({ now: 1000 });
    await reconciler.sweep({ now: 300999 });
    assert.equal(recorded.length, beforeSweep + 1);
    await reconciler.sweep({ now: 301000 });
    assert.equal(recorded.length, beforeSweep + 2);
    observe("Active epic sweeps run immediately and then every five minutes", {
      beforeSweep,
      afterSweep: recorded.length,
    });
    let release!: () => void;
    let enter!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const entered = new Promise<void>((resolve) => (enter = resolve));
    let loads = 0;
    let publications = 0;
    const coalesced = createEpicReconciler({
      db,
      lifecycle,
      tracker: {
        ...tracker,
        async loadEpic(id) {
          loads++;
          const value = structuredClone(await tracker.loadEpic(id));
          if (loads === 1) {
            enter();
            await gate;
          }
          return value;
        },
      },
      onChanges() {
        assert(db.inTransaction);
        publications++;
      },
    });
    const flight = coalesced.reconcile(target);
    await entered;
    assert.deepEqual(readyItems(db, target).readyItemIds, []);
    const same = coalesced.reconcile(target);
    assert.equal(flight, same);
    const waiter = new AbortController();
    const canceledWaiter = assert.rejects(
      coalesced.reconcile({ ...target, signal: waiter.signal }),
      /Waiter canceled/,
    );
    waiter.abort(new Error("Waiter canceled"));
    await canceledWaiter;
    assert.deepEqual(readyItems(db, target).readyItemIds, []);
    release();
    await flight;
    assert.equal(loads, 2);
    assert.equal(publications, 1);
    observe(
      "Concurrent issue events share one writer and perform a trailing authoritative refresh",
      { loads, publications },
    );
    observe(
      "Canceled waiters stop awaiting without canceling shared authoritative reconciliation",
      { loads, publications, waiterAborted: waiter.signal.aborted },
    );
    let staleRelease!: () => void;
    let staleEnter!: () => void;
    const staleGate = new Promise<void>((resolve) => (staleRelease = resolve));
    const staleEntered = new Promise<void>((resolve) => (staleEnter = resolve));
    const stale = createEpicReconciler({
      db,
      lifecycle,
      tracker: {
        ...tracker,
        async loadEpic(id) {
          const value = await tracker.loadEpic(id);
          staleEnter();
          await staleGate;
          return value;
        },
      },
      onChanges() {
        throw new Error("Stale publication reached callback");
      },
    });
    const old = stale.reconcile(target);
    await staleEntered;
    db.run(
      "UPDATE linear_session SET creator_id='new-owner' WHERE session_id IN (SELECT session_key FROM work_item WHERE epic_id=?)",
      [target.epicId],
    );
    staleRelease();
    await assert.rejects(old, /authority changed/);
    observe("Ownership changes fence delayed publications before canonical effects", {
      owner: "new-owner",
    });
    lifecycle.issues.get("b")!.stateType = "canceled";
    await reconciler.reconcile(target);
    assert.deepEqual(recorded.at(-1)!.canceledItemIds, [b]);
    assert.deepEqual(readyItems(db, target).readyItemIds, []);
    lifecycle.issue.stateType = "canceled";
    await reconciler.reconcile(target);
    assert(recorded.at(-1)!.parentCanceled);
    observe(
      "Linear child and parent cancellation reach canonical cancellation effects",
      recorded.at(-1),
    );
    tracker.epics.get("parent")!.subIssues = [];
    lifecycle.issue.stateType = "started";
    await reconciler.reconcile(target);
    assert.deepEqual(recorded.at(-1)!.addedItemIds, []);
    assert.deepEqual(recorded.at(-1)!.removedItemIds, [b]);
    observe(
      "Removing every child preserves history without manufacturing parent work",
      recorded.at(-1),
    );
    lifecycle.issues.get("b")!.stateType = "started";
    tracker.epics.get("parent")!.subIssues = [
      { linearIssueId: "b", identifier: "SYNC-3", title: "B" },
    ];
    await reconciler.reconcile(target);
    assert.equal(recorded.at(-1)!.addedItemIds.length, 1);
    const firstRestoration = recorded.at(-1)!.addedItemIds[0]!;
    assert.notEqual(firstRestoration, b);
    tracker.epics.get("parent")!.subIssues = [];
    const pendingRemoval = createEpicReconciler({
      db,
      tracker,
      lifecycle,
      onChanges(changes) {
        for (const id of changes.removedItemIds) applyWorkItemEvent(db, id, "cancel");
      },
      async afterChanges() {
        throw new Error("Interrupted removed child join");
      },
    });
    await assert.rejects(pendingRemoval.reconcile(target), /removed child join/);
    tracker.epics.get("parent")!.subIssues = [
      { linearIssueId: "b", identifier: "SYNC-3", title: "B" },
    ];
    await reconciler.reconcile(target);
    const restored = recorded.at(-1)!;
    assert.equal(restored.addedItemIds.length, 1);
    const secondRestoration = restored.addedItemIds[0]!;
    assert.notEqual(secondRestoration, firstRestoration);
    assert(!restored.removedItemIds.includes(secondRestoration));
    assert.deepEqual(restored.removedItemIds, []);
    assert.deepEqual(joinedChanges.at(-1)!.removedItemIds, [firstRestoration]);
    assert.deepEqual(readyItems(db, target).readyItemIds, [secondRestoration]);
    await reconciler.reconcile(target);
    assert.deepEqual(recorded.at(-1)!.addedItemIds, []);
    const childHistory = db
      .query<
        { id: string; state: string; present: number; taskKey: string; branch: string },
        [string]
      >(
        `SELECT i.id,i.state,p.present,i.task_key AS taskKey,i.branch_name AS branch FROM work_item i
       JOIN work_item_specification p ON p.item_id=i.id WHERE i.linear_issue_id=? ORDER BY i.created_at,i.id`,
      )
      .all("b");
    assert.equal(childHistory.filter((item) => item.present === 1).length, 1);
    assert.equal(childHistory.length, 3);
    assert(
      childHistory.filter((item) => item.present === 0).every((item) => item.state === "cancelled"),
    );
    assert(
      childHistory.some(
        (item) => item.taskKey.endsWith(":reappearance:1") && item.branch.endsWith("-r1"),
      ),
    );
    assert(
      childHistory.some(
        (item) => item.taskKey.endsWith(":reappearance:2") && item.branch.endsWith("-r2"),
      ),
    );
    observe(
      "Reappearing children receive retry-safe new identities while old effects only join old canceled history",
      childHistory,
    );
    let stopRelease!: () => void;
    let stopEnter!: () => void;
    const stopGate = new Promise<void>((resolve) => (stopRelease = resolve));
    const stopEntered = new Promise<void>((resolve) => (stopEnter = resolve));
    const stopping = createEpicReconciler({
      db,
      lifecycle,
      tracker: {
        ...tracker,
        async loadEpic(id) {
          const value = await tracker.loadEpic(id);
          stopEnter();
          await stopGate;
          return value;
        },
      },
      onChanges() {
        throw new Error("Stopped publication reached database");
      },
    });
    const stoppedRequest = assert.rejects(stopping.reconcile(target), /reconciliation stopped/);
    await stopEntered;
    let joined = false;
    const shutdown = stopping.close().then(() => {
      joined = true;
    });
    await Promise.resolve();
    assert.equal(joined, false);
    await assert.rejects(stopping.reconcile(target), /reconciliation stopped/);
    stopRelease();
    await Promise.all([stoppedRequest, shutdown]);
    assert(joined);
    assert.equal(
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM epic_reconciliation_request").get()!.n,
      1,
    );
    observe("Shutdown rejects new work and joins held tracker reads before database closure", {
      joined,
    });
    writeFileSync(join(root, "observations.json"), JSON.stringify(observations, null, 2));
    return observations;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const root = mkdtempSync(join(tmpdir(), "paws-reconciliation-"));
  const observations = await probeEpicReconciliation(root);
  console.log(JSON.stringify({ root, observations }));
}
