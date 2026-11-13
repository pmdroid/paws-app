import assert from "node:assert/strict";
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyWorkItemEventSteps,
  bindLinearSessionTask,
  openPawsStore,
  recordLinearInstallation,
  saveTaskModeSteps,
  type Db,
  type Q,
} from "../../src/db";
import {
  createItemReconciler,
  intakeDelegatedIssue,
  readyItemsSteps,
  SWEEP_FULL_REFRESH_MS,
  type ItemChanges,
} from "../../src/intake";
import { createFakeLinearIssueLifecycle, createFakeTracker } from "../../src/linear";
import { pgliteServer } from "../pglite";

async function delegationReadyItemIds(
  db: Db,
  delegationId: string,
  workspaceId: string,
): Promise<string[]> {
  const items = await db.run((q) =>
    q.all(
      q.orm
        .select({ id: q.t.workItem.id })
        .from(q.t.workItem)
        .leftJoin(q.t.workItemSpecification, eq(q.t.workItemSpecification.itemId, q.t.workItem.id))
        .where(
          and(
            eq(q.t.workItem.delegationId, delegationId),
            sql`COALESCE(${q.t.workItemSpecification.present},1)=1`,
          ),
        )
        .orderBy(asc(q.t.workItem.position), asc(q.t.workItem.id)),
    ),
  );
  const ready: string[] = [];
  for (const item of items) {
    try {
      ready.push(
        ...(await db.run((q) => readyItemsSteps(q, { itemId: item.id, workspaceId }))).readyItemIds,
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "Dependency workspace or task ownership changed"
      )
        throw error;
    }
  }
  return ready;
}

export async function probeEpicReconciliation(root: string) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const postgres = await pgliteServer();
  const db = postgres.store;
  const change = (update: (q: Q) => PromiseLike<unknown>) => db.run((q) => q.exec(update(q)));
  const rows = (table: "itemReconciliationEffect" | "itemReconciliationRequest") =>
    db.run(function* (q) {
      return (yield* q.one(q.orm.select({ n: count() }).from(q.t[table])))!.n;
    });
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
    const intake = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "parent",
      now: 1000,
    });
    assert(intake.ok);
    await change((q) =>
      q.orm.insert(q.t.workspace).values({
        id: "workspace",
        linearOrganizationId: "org",
        name: "Workspace",
        createdAt: 1000,
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
      actorId: "human",
    });
    const delegationId = intake.delegation.id;
    const target = { itemId: intake.items[0]!.id, workspaceId: "workspace" };
    const recorded: ItemChanges[] = [];
    const joinedChanges: ItemChanges[] = [];
    let fail = false;
    const reconciler = createItemReconciler({
      store: db,
      tracker,
      lifecycle,
      *onChanges(q, changes) {
        yield* [];
        if (fail) throw new Error("Injected canonical effect failure");
        for (const id of changes.addedItemIds) yield* saveTaskModeSteps(q, id, "code", 0, true);
        for (const id of [...changes.removedItemIds, ...changes.canceledItemIds]) {
          const row = (yield* q.one(
            q.orm
              .select({ state: q.t.workItem.state })
              .from(q.t.workItem)
              .where(eq(q.t.workItem.id, id)),
          ))!;
          if (!["cancelled", "merged", "completed"].includes(row.state))
            yield* applyWorkItemEventSteps(q, id, "cancel");
        }
        recorded.push(structuredClone(changes));
      },
      async afterChanges(changes) {
        joinedChanges.push(structuredClone(changes));
      },
    });
    await reconciler.reconcile(target);
    const specification = async () =>
      (await db.run((q) =>
        q.one(
          q.orm
            .select({
              hash: q.t.workItemSpecification.hash,
              revision: q.t.workItemSpecification.revision,
              present: q.t.workItemSpecification.present,
            })
            .from(q.t.workItemSpecification)
            .where(eq(q.t.workItemSpecification.itemId, intake.items[0]!.id)),
        ),
      ))!;
    const itemField = async (id: string) =>
      (await db.run((q) =>
        q.one(q.orm.select().from(q.t.workItem).where(eq(q.t.workItem.id, id))),
      ))!;
    assert.equal((await specification()).revision, 1);
    assert.equal((await specification()).hash.length, 64);
    assert.deepEqual(recorded[0]!.specChangedItemIds, []);
    await reconciler.reconcile(target);
    assert.equal((await specification()).revision, 1);
    observe(
      "Initial specifications are persisted without invalidating unchanged evidence",
      await specification(),
    );
    const firstHash = (await specification()).hash;
    tracker.epics.get("parent")!.subIssues[0]!.description = "Changed acceptance criteria";
    await reconciler.reconcile(target);
    assert.equal((await specification()).revision, 2);
    assert.notEqual((await specification()).hash, firstHash);
    assert.deepEqual(recorded.at(-1)!.specChangedItemIds, [intake.items[0]!.id]);
    tracker.epics.get("parent")!.description = "Changed parent instructions";
    await reconciler.reconcile(target);
    assert.equal((await specification()).revision, 3);
    observe(
      "Child and parent instruction edits produce durable specification revisions",
      recorded.at(-1),
    );
    const before = await specification();
    tracker.epics.get("parent")!.subIssues[0]!.description = "Must roll back";
    fail = true;
    await assert.rejects(reconciler.reconcile(target), /Injected canonical effect failure/);
    assert.deepEqual(await specification(), before);
    assert(
      !JSON.stringify((await itemField(intake.items[0]!.id)).brief).includes("Must roll back"),
    );
    fail = false;
    observe(
      "A failed canonical invalidation rolls back brief and specification publication",
      await specification(),
    );
    let interruptedEffects: ItemChanges | null = null;
    const interrupted = createItemReconciler({
      store: db,
      tracker,
      lifecycle,
      *onChanges(q, changes) {
        yield* [];
        interruptedEffects = structuredClone(changes);
      },
      async afterChanges() {
        throw new Error("Injected coordinator interruption before live join");
      },
    });
    await assert.rejects(interrupted.reconcile(target), /coordinator interruption/);
    assert.equal(await rows("itemReconciliationEffect"), 1);
    assert.deepEqual(await delegationReadyItemIds(db, delegationId, target.workspaceId), []);
    const recoveredDb = await openPawsStore({ url: postgres.url, pgliteDir: "" });
    try {
      let recoveredEffects: ItemChanges | null = null;
      const recovered = createItemReconciler({
        store: recoveredDb.store,
        tracker,
        lifecycle,
        *onChanges(q, changes) {
          yield* [];
          recoveredEffects = structuredClone(changes);
        },
        async afterChanges(changes) {
          assert.deepEqual(changes.specChangedItemIds, interruptedEffects!.specChangedItemIds);
        },
      });
      await recovered.reconcile(target);
      assert.deepEqual(recoveredEffects!.specChangedItemIds, []);
      assert.equal(await rows("itemReconciliationEffect"), 0);
      observe(
        "Interrupted live effects survive coordinator reconstruction until joined and refreshed",
        recoveredEffects,
      );
    } finally {
      await recoveredDb.close();
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
    assert.equal((await specification()).present, 0);
    assert.equal((await itemField(intake.items[0]!.id)).state, "cancelled");
    assert.equal(
      (await db.run((q) =>
        q.one(
          q.orm
            .select({ mode: q.t.workItemTask.mode })
            .from(q.t.workItemTask)
            .where(eq(q.t.workItemTask.itemId, b)),
        ),
      ))!.mode,
      "code",
    );
    observe(
      "Child replacement queues new code work and canonically cancels removed history",
      recorded.at(-1),
    );
    tracker.deps.set("parent", [{ blockerLinearIssueId: "outside", blockedLinearIssueId: "b" }]);
    await reconciler.reconcile(target);
    assert.deepEqual(await delegationReadyItemIds(db, delegationId, target.workspaceId), []);
    lifecycle.issues.get("outside")!.stateType = "completed";
    const beforeWrong = recorded.length;
    await reconciler.issueChanged({ issueId: "outside", organizationId: "other" });
    assert.equal(recorded.length, beforeWrong);
    await reconciler.issueChanged({ issueId: "outside", organizationId: "org" });
    assert.deepEqual(await delegationReadyItemIds(db, delegationId, target.workspaceId), [b]);
    observe(
      "External blocker events resync only matching organization epics",
      await db.run((q) => readyItemsSteps(q, { itemId: b, workspaceId: target.workspaceId })),
    );
    const beforeSweep = recorded.length;
    const sweptAt = Date.now();
    await reconciler.sweep({ now: sweptAt });
    assert.equal(recorded.length, beforeSweep);
    await reconciler.sweep({ now: sweptAt + SWEEP_FULL_REFRESH_MS });
    assert.equal(recorded.length, beforeSweep + 1);
    observe("Active epic sweeps skip unchanged epics until the full refresh window", {
      beforeSweep,
      afterSweep: recorded.length,
    });
    let release!: () => void;
    let enter!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const entered = new Promise<void>((resolve) => (enter = resolve));
    let loads = 0;
    let publications = 0;
    const coalesced = createItemReconciler({
      store: db,
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
      *onChanges() {
        yield* [];
        publications++;
      },
    });
    const flight = coalesced.reconcile(target);
    await entered;
    assert.deepEqual(await delegationReadyItemIds(db, delegationId, target.workspaceId), []);
    const same = coalesced.reconcile(target);
    const waiter = new AbortController();
    const canceledWaiter = assert.rejects(
      coalesced.reconcile({ ...target, signal: waiter.signal }),
      /Waiter canceled/,
    );
    waiter.abort(new Error("Waiter canceled"));
    await canceledWaiter;
    assert.deepEqual(await delegationReadyItemIds(db, delegationId, target.workspaceId), []);
    release();
    await Promise.all([flight, same]);
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
    const stale = createItemReconciler({
      store: db,
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
      *onChanges() {
        yield* [];
        throw new Error("Stale publication reached callback");
      },
    });
    const old = stale.reconcile(target);
    await staleEntered;
    await change((q) =>
      q.orm
        .update(q.t.linearSession)
        .set({ creatorId: "new-owner" })
        .where(
          inArray(
            q.t.linearSession.sessionId,
            q.orm
              .select({ sessionKey: sql<string>`${q.t.workItem.sessionKey}` })
              .from(q.t.workItem)
              .where(eq(q.t.workItem.delegationId, delegationId)),
          ),
        ),
    );
    staleRelease();
    await assert.rejects(old, /authority changed/);
    observe("Ownership changes fence delayed publications before canonical effects", {
      owner: "new-owner",
    });
    const keepIssue = { linearIssueId: "keep", identifier: "SYNC-4", title: "Keep" };
    tracker.epics.get("parent")!.subIssues = [
      { linearIssueId: "b", identifier: "SYNC-3", title: "B" },
      keepIssue,
    ];
    lifecycle.issues.set("keep", { ...lifecycle.issue, id: "keep", stateType: "started" });
    await reconciler.reconcile(target);
    const keep = recorded.at(-1)!.addedItemIds[0]!;
    await change((q) =>
      q.orm.update(q.t.workItem).set({ cancelRequested: 1 }).where(eq(q.t.workItem.id, keep)),
    );
    lifecycle.issues.get("b")!.stateType = "canceled";
    await reconciler.reconcile(target);
    assert.deepEqual(recorded.at(-1)!.canceledItemIds, [b]);
    assert.deepEqual(await delegationReadyItemIds(db, delegationId, target.workspaceId), []);
    tracker.epics.get("parent")!.subIssues = [keepIssue];
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
      keepIssue,
      { linearIssueId: "b", identifier: "SYNC-3", title: "B" },
    ];
    await reconciler.reconcile(target);
    assert.equal(recorded.at(-1)!.addedItemIds.length, 1);
    const firstRestoration = recorded.at(-1)!.addedItemIds[0]!;
    assert.notEqual(firstRestoration, b);
    tracker.epics.get("parent")!.subIssues = [keepIssue];
    const pendingRemoval = createItemReconciler({
      store: db,
      tracker,
      lifecycle,
      *onChanges(q, changes) {
        for (const id of changes.removedItemIds) yield* applyWorkItemEventSteps(q, id, "cancel");
      },
      async afterChanges() {
        throw new Error("Interrupted removed child join");
      },
    });
    await assert.rejects(pendingRemoval.reconcile(target), /removed child join/);
    tracker.epics.get("parent")!.subIssues = [
      keepIssue,
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
    assert.deepEqual(await delegationReadyItemIds(db, delegationId, target.workspaceId), [
      secondRestoration,
    ]);
    await reconciler.reconcile(target);
    assert.deepEqual(recorded.at(-1)!.addedItemIds, []);
    const childHistory = await db.run((q) =>
      q.all(
        q.orm
          .select({
            id: q.t.workItem.id,
            state: q.t.workItem.state,
            present: q.t.workItemSpecification.present,
            taskKey: sql<string>`${q.t.workItem.taskKey}`,
            branch: q.t.workItem.branchName,
          })
          .from(q.t.workItem)
          .innerJoin(
            q.t.workItemSpecification,
            eq(q.t.workItemSpecification.itemId, q.t.workItem.id),
          )
          .where(eq(q.t.workItem.linearIssueId, "b"))
          .orderBy(asc(q.t.workItem.createdAt), asc(q.t.workItem.id)),
      ),
    );
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
    const stopping = createItemReconciler({
      store: db,
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
      *onChanges() {
        yield* [];
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
    assert.equal(await rows("itemReconciliationRequest"), 1);
    observe("Shutdown rejects new work and joins held tracker reads before database closure", {
      joined,
    });
    lifecycle.issue.stateType = "canceled";
    await reconciler.reconcile(target);
    assert(recorded.at(-1)!.parentCanceled);
    observe(
      "Linear child and parent cancellation reach canonical cancellation effects",
      recorded.at(-1),
    );
    writeFileSync(join(root, "observations.json"), JSON.stringify(observations, null, 2));
    return observations;
  } finally {
    await postgres.close();
  }
}

if (import.meta.main) {
  const root = mkdtempSync(join(tmpdir(), "paws-reconciliation-"));
  const observations = await probeEpicReconciliation(root);
  console.log(JSON.stringify({ root, observations }));
}
