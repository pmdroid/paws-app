import { syncSteps } from "../../src/runner-backend";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, JOB_KIND } from "../../src/core";
import {
  JobLoop,
  applyLinearCommand,
  applyWorkItemEvent,
  bindLinearSessionTask,
  claimNextJob,
  completeJob,
  enqueueJob,
  getWorkItem,
  insertRun,
  recordLinearInstallation,
  saveCheckpoint,
  saveTaskMode,
  setCurrentRun,
  applyWorkItemEventSteps,
  saveCheckpointSteps,
  setCurrentRunSteps,
  markRunSteps,
  type Db,
  type Q,
  type Steps,
} from "../../src/db";
import {
  createItemReconciler,
  createPublicationReadiness,
  hasPendingDelegationChanges,
  intakeDelegatedIssue,
  readyItemsSteps,
  type ItemChanges,
} from "../../src/intake";
import { createFakeLinearIssueLifecycle, createFakeTracker } from "../../src/linear";
import { createAdmission } from "../../src/scheduler";
import { tempStore } from "../pglite";

function mergeAdmission(db: Db) {
  const admission = createAdmission({ db });
  return async (itemId: string) => (await admission.canMerge(itemId)).ok;
}

export async function probePublicationReadiness(root: string) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const observations: { name: string; passed: boolean; observed: unknown }[] = [];
  const observe = (name: string, observed: unknown) =>
    observations.push({ name, passed: true, observed });
  async function fixture(name: string, withChildren = false) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const { db, close } = await tempStore();
    const clock = new FakeClock(1000);
    const tracker = createFakeTracker([
      {
        linearIssueId: withChildren ? "parent" : "issue",
        identifier: "PUB-1",
        title: "Issue",
        description: "Original criteria",
        subIssues: withChildren
          ? [
              {
                linearIssueId: "issue",
                identifier: "PUB-2",
                title: "Issue",
                description: "Original criteria",
              },
              { linearIssueId: "free", identifier: "PUB-3", title: "Independent" },
              { linearIssueId: "manual", identifier: "PUB-4", title: "Manual prerequisite" },
            ]
          : [],
      },
    ]);
    const lifecycle = createFakeLinearIssueLifecycle({
      id: withChildren ? "parent" : "issue",
      teamId: "team",
      stateType: "started",
      assigneeId: "human",
      delegateId: "app",
    });
    for (const id of ["issue", "free", "manual", "outside"])
      lifecycle.issues.set(id, { ...lifecycle.issue, id });
    const intake = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: withChildren ? "parent" : "issue",
      now: clock.now(),
    });
    assert(intake.ok);
    await db.run((q) =>
      q.exec(
        q.orm.insert(q.t.workspace).values({
          id: "workspace",
          linearOrganizationId: "org",
          name: "Workspace",
          createdAt: 1000,
        }),
      ),
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
    const itemId = intake.items.find((item) => item.linearIssueId === "issue")!.id;
    const target = { delegationId: intake.delegation.id, workspaceId: "workspace" };
    let onChanges = (_q: Q, _changes: ItemChanges): Steps<void> => syncSteps(() => {});
    let afterChanges = async (_changes: ItemChanges) => {};
    const reconciler = createItemReconciler({
      store: db,
      tracker,
      lifecycle,
      onChanges: (q, changes) => onChanges(q, changes),
      afterChanges: (changes) => afterChanges(changes),
      now: () => clock.now(),
    });
    await reconciler.reconcile({ itemId, workspaceId: target.workspaceId });
    await applyWorkItemEvent(db, itemId, "dispatched");
    await applyWorkItemEvent(db, itemId, "turn_ended");
    await applyWorkItemEvent(db, itemId, "closeout_accepted");
    const run = await insertRun(db, {
      itemId,
      agent: "scripted-producer",
      kind: "implement",
      status: "ended",
      now: clock.now(),
    });
    await setCurrentRun(db, itemId, run.id);
    const candidate = { sha: "a".repeat(40), baseSha: "b".repeat(40) };
    await saveCheckpoint(db, itemId, {
      phase: "merge_queue",
      wipCommit: candidate.sha,
      baseSha: candidate.baseSha,
    });
    let loads = 0;
    const load = tracker.loadEpic.bind(tracker);
    tracker.loadEpic = async (id) => {
      loads++;
      return load(id);
    };
    async function queue() {
      return await enqueueJob(db, {
        queue: JOB_KIND.merge,
        payload: { itemId },
        now: clock.now(),
      });
    }
    async function claim() {
      await queue();
      const job = await claimNextJob(db, {
        workerId: "publication-proof",
        leaseMs: 10_000,
        now: clock.now(),
        queues: [JOB_KIND.merge],
      });
      assert(job);
      return job;
    }
    return {
      db,
      clock,
      tracker,
      lifecycle,
      reconciler,
      itemId,
      target,
      candidate,
      run,
      claim,
      queue,
      loads: () => loads,
      setEffects(apply: typeof onChanges, joinEffects: typeof afterChanges = async () => {}) {
        onChanges = apply;
        afterChanges = joinEffects;
      },
      async close() {
        await reconciler.close();
        await close();
      },
    };
  }
  {
    const f = await fixture("unchanged");
    try {
      const first = await f.claim();
      const guard = createPublicationReadiness({
        store: f.db,
        reconciler: f.reconciler,
        canMerge: mergeAdmission(f.db),
        now: () => f.clock.now(),
      });
      const beforeGeneration = (
        await f.db.run((q) =>
          readyItemsSteps(q, {
            itemId: f.itemId,
            workspaceId: "workspace",
          }),
        )
      ).generation;
      assert(await guard.publicationReady(f.itemId, "publish", undefined, f.candidate));
      const publishGeneration = (
        await f.db.run((q) =>
          readyItemsSteps(q, {
            itemId: f.itemId,
            workspaceId: "workspace",
          }),
        )
      ).generation;
      assert.equal(publishGeneration, beforeGeneration + 1);
      assert.equal(f.loads(), 1);
      assert(await guard.publicationReady(f.itemId, "publish", undefined, f.candidate));
      assert.equal(f.loads(), 1);
      assert(await guard.publicationReady(f.itemId, "merge", undefined, f.candidate));
      assert.equal(f.loads(), 2);
      assert(await guard.publicationReady(f.itemId, "merge", undefined, f.candidate));
      assert.equal(f.loads(), 2);
      observe(
        "Unchanged authoritative reads allow publication and require a separate post-verification merge refresh",
        {
          loads: f.loads(),
          beforeGeneration,
          publishGeneration,
          mergeGeneration: (
            await f.db.run((q) =>
              readyItemsSteps(q, { itemId: f.itemId, workspaceId: "workspace" }),
            )
          ).generation,
          state: (await getWorkItem(f.db, f.itemId))!.state,
        },
      );
      assert(await completeJob(f.db, first, f.clock.now()));
      await f.claim();
      assert(await guard.publicationReady(f.itemId, "merge", undefined, f.candidate));
      assert.equal(f.loads(), 3);
      const rebased = { sha: "c".repeat(40), baseSha: "d".repeat(40) };
      assert(await guard.publicationReady(f.itemId, "merge", undefined, rebased));
      assert.equal(f.loads(), 4);
      observe(
        "New job claims and exact rebased candidates each require fresh authoritative reads",
        { loads: f.loads(), rebased },
      );
    } finally {
      await f.close();
    }
  }
  {
    const f = await fixture("missed-webhook");
    try {
      await f.claim();
      f.setEffects(function* (q, changes) {
        if (!changes.specChangedItemIds.includes(f.itemId)) return;
        yield* applyWorkItemEventSteps(q, f.itemId, "restart");
        yield* saveCheckpointSteps(q, f.itemId, null);
        yield* setCurrentRunSteps(q, f.itemId, null);
        yield* markRunSteps(q, f.run.id, "lost", f.clock.now());
      });
      const guard = createPublicationReadiness({
        store: f.db,
        reconciler: f.reconciler,
        canMerge: mergeAdmission(f.db),
        now: () => f.clock.now(),
      });
      let mergeCalls = 0;
      f.tracker.epics.get("issue")!.description = "Acceptance criteria changed without a webhook";
      if (await guard.publicationReady(f.itemId, "merge", undefined, f.candidate)) mergeCalls++;
      assert.equal(mergeCalls, 0);
      assert.equal((await getWorkItem(f.db, f.itemId))!.state, "queued");
      assert.equal((await getWorkItem(f.db, f.itemId))!.currentRunId, null);
      assert.deepEqual(
        await f.db.run((q) =>
          q.all(
            q.orm
              .select({ revision: q.t.workItemSpecification.revision })
              .from(q.t.workItemSpecification)
              .where(eq(q.t.workItemSpecification.itemId, f.itemId)),
          ),
        ),
        [{ revision: 2 }],
      );
      observe(
        "A missed criteria webhook is discovered before an old approved candidate can merge",
        {
          mergeCalls,
          state: (await getWorkItem(f.db, f.itemId))!.state,
          loads: f.loads(),
        },
      );
    } finally {
      await f.close();
    }
  }
  {
    const f = await fixture("owned-job-join");
    try {
      let ownedJob!: ReturnType<JobLoop["tick"]>;
      let exited = false;
      let joined = false;
      let mergeCalls = 0;
      const guard = createPublicationReadiness({
        store: f.db,
        reconciler: f.reconciler,
        canMerge: mergeAdmission(f.db),
        now: () => f.clock.now(),
      });
      f.setEffects(
        (_q, changes) =>
          syncSteps(() => {
            if (!changes.specChangedItemIds.includes(f.itemId)) return;
            void applyLinearCommand(f.db, {
              type: "cancel",
              itemId: f.itemId,
              source: "linear",
              requestedAt: f.clock.now(),
            }).then(({ applied }) => assert(applied));
          }),
        async (changes) => {
          if (!changes.specChangedItemIds.includes(f.itemId)) return;
          await ownedJob;
          assert(exited);
          joined = true;
        },
      );
      f.tracker.epics.get("issue")!.description =
        "Changed while the owned merge job is awaiting refresh";
      const loop = new JobLoop(f.db, f.clock, { workerId: "actual-owned-merge", leaseMs: 30 });
      loop.register(JOB_KIND.merge, async (_job, context) => {
        try {
          if (await guard.publicationReady(f.itemId, "merge", context.signal, f.candidate))
            mergeCalls++;
        } finally {
          exited = true;
        }
      });
      await f.queue();
      ownedJob = loop.tick();
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          ownedJob,
          new Promise<never>((_resolve, reject) => {
            watchdog = setTimeout(
              () =>
                reject(new Error("Owned publication job deadlocked during criteria invalidation")),
              2000,
            );
          }),
        ]);
      } finally {
        clearTimeout(watchdog);
      }
      for (
        let tries = 0;
        tries < 100 && (await hasPendingDelegationChanges(f.db, f.target.delegationId));
        tries++
      )
        await Bun.sleep(10);
      assert(joined);
      assert(exited);
      assert.equal(mergeCalls, 0);
      assert(!(await hasPendingDelegationChanges(f.db, f.target.delegationId)));
      const job = (await f.db.run((q) =>
        q.one(
          q.orm
            .select({ status: q.t.job.status, worker: q.t.job.lockedBy })
            .from(q.t.job)
            .where(eq(q.t.job.queue, "github.merge")),
        ),
      ))!;
      assert.equal(job.status, "cancelled");
      observe(
        "Canonical cancellation aborts a running owned job awaiting its own shared refresh and joins without deadlock",
        {
          exited,
          joined,
          mergeCalls,
          job,
          state: (await getWorkItem(f.db, f.itemId))!.state,
        },
      );
    } finally {
      await f.close();
    }
  }
  {
    const f = await fixture("transport-repair");
    try {
      await f.claim();
      const original = f.tracker.loadEpic;
      f.tracker.loadEpic = async () => {
        throw new Error("Scripted temporary Linear read failure");
      };
      const guard = createPublicationReadiness({
        store: f.db,
        reconciler: f.reconciler,
        canMerge: mergeAdmission(f.db),
        now: () => f.clock.now(),
      });
      assert.equal(await guard.publicationReady(f.itemId, "merge", undefined, f.candidate), false);
      assert(await hasPendingDelegationChanges(f.db, f.target.delegationId));
      f.tracker.loadEpic = original;
      assert(await guard.publicationReady(f.itemId, "merge", undefined, f.candidate));
      assert(!(await hasPendingDelegationChanges(f.db, f.target.delegationId)));
      observe(
        "Failed authoritative reads hold publication durably and repaired reads release the same candidate",
        {
          loads: f.loads(),
          pending: await hasPendingDelegationChanges(f.db, f.target.delegationId),
        },
      );
    } finally {
      await f.close();
    }
  }
  {
    const f = await fixture("new-blocker", true);
    try {
      let job = await f.claim();
      const itemFor = async (issue: string) =>
        (await f.db.run((q) =>
          q.one(
            q.orm
              .select({ id: q.t.workItem.id })
              .from(q.t.workItem)
              .where(eq(q.t.workItem.linearIssueId, issue)),
          ),
        ))!.id;
      const manual = await itemFor("manual");
      const independent = await itemFor("free");
      await applyWorkItemEvent(f.db, manual, "dispatched");
      await applyWorkItemEvent(f.db, manual, "run_failed");
      await applyWorkItemEvent(f.db, manual, "take_over");
      await saveTaskMode(f.db, manual, "code");
      f.tracker.deps.set("parent", [
        { blockerLinearIssueId: "outside", blockedLinearIssueId: "issue" },
        { blockerLinearIssueId: "manual", blockedLinearIssueId: "issue" },
      ]);
      const guard = createPublicationReadiness({
        store: f.db,
        reconciler: f.reconciler,
        canMerge: mergeAdmission(f.db),
        now: () => f.clock.now(),
      });
      assert.equal(await guard.publicationReady(f.itemId, "merge", undefined, f.candidate), false);
      assert.equal((await getWorkItem(f.db, f.itemId))!.state, "merge_queue");
      assert.deepEqual(
        (
          await f.db.run((q) =>
            readyItemsSteps(q, { itemId: independent, workspaceId: "workspace" }),
          )
        ).readyItemIds,
        [independent],
      );
      f.lifecycle.issues.get("outside")!.stateType = "completed";
      assert.equal(await guard.publicationReady(f.itemId, "merge", undefined, f.candidate), false);
      f.lifecycle.issues.get("manual")!.stateType = "completed";
      assert(await guard.publicationReady(f.itemId, "merge", undefined, f.candidate));
      assert(await completeJob(f.db, job, f.clock.now()));
      job = await f.claim();
      f.lifecycle.issues.get("manual")!.stateType = "started";
      assert.equal(await guard.publicationReady(f.itemId, "merge", undefined, f.candidate), false);
      f.lifecycle.issues.get("manual")!.stateType = "canceled";
      assert(await guard.publicationReady(f.itemId, "merge", undefined, f.candidate));
      assert(await completeJob(f.db, job, f.clock.now()));
      job = await f.claim();
      f.lifecycle.issues.get("manual")!.stateType = "completed";
      f.tracker.deps.set("parent", [
        ...f.tracker.deps.get("parent")!,
        { blockerLinearIssueId: "issue", blockedLinearIssueId: "manual" },
      ]);
      assert.equal(await guard.publicationReady(f.itemId, "merge", undefined, f.candidate), false);
      assert.deepEqual(
        (
          await f.db.run((q) =>
            readyItemsSteps(q, { itemId: independent, workspaceId: "workspace" }),
          )
        ).readyItemIds,
        [independent],
      );
      observe(
        "Fresh unfinished or cyclic blockers hold a verified candidate while exact completed or canceled manual and external blockers release it and unrelated work stays ready",
        {
          loads: f.loads(),
          state: (await getWorkItem(f.db, f.itemId))!.state,
          independentReady: (
            await f.db.run((q) =>
              readyItemsSteps(q, { itemId: independent, workspaceId: "workspace" }),
            )
          ).readyItemIds,
        },
      );
    } finally {
      await f.close();
    }
  }
  {
    const f = await fixture("authority");
    try {
      await f.claim();
      const load = f.tracker.loadEpic;
      f.tracker.loadEpic = async (id) => {
        const value = await load(id);
        await f.db.run((q) =>
          q.exec(
            q.orm
              .update(q.t.linearSession)
              .set({ generation: sql`${q.t.linearSession.generation} + 1` })
              .where(eq(q.t.linearSession.sessionId, "session")),
          ),
        );
        return value;
      };
      const guard = createPublicationReadiness({
        store: f.db,
        reconciler: f.reconciler,
        canMerge: mergeAdmission(f.db),
        now: () => f.clock.now(),
      });
      assert.equal(await guard.publicationReady(f.itemId, "merge", undefined, f.candidate), false);
      assert(await hasPendingDelegationChanges(f.db, f.target.delegationId));
      observe(
        "A session generation change during the fresh read cannot approve the old publication context",
        { pending: await hasPendingDelegationChanges(f.db, f.target.delegationId) },
      );
    } finally {
      await f.close();
    }
  }
  {
    const f = await fixture("advance-policy");
    try {
      await f.claim();
      let permitted = false;
      const guard = createPublicationReadiness({
        store: f.db,
        reconciler: f.reconciler,
        canMerge: async (itemId) => permitted && (await mergeAdmission(f.db)(itemId)),
        now: () => f.clock.now(),
      });
      assert.equal(await guard.publicationReady(f.itemId, "merge", undefined, f.candidate), false);
      permitted = true;
      assert(await guard.publicationReady(f.itemId, "merge", undefined, f.candidate));
      observe("Fresh tracker data cannot override the current canonical publication policy", {
        loads: f.loads(),
        permitted,
      });
    } finally {
      await f.close();
    }
  }
  writeFileSync(join(root, "observations.json"), JSON.stringify(observations, null, 2));
  return observations;
}

if (import.meta.main) {
  const root = mkdtempSync(join(tmpdir(), "paws-publication-readiness-"));
  console.log(JSON.stringify({ root, observations: await probePublicationReadiness(root) }));
}
