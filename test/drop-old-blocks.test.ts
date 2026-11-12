import { syncSteps } from "../src/runner-backend";
import { confirmFakeMergePg } from "./fake-workspace";
import { expect, test } from "bun:test";
import { FakeClock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  bindLinearSessionTask,
  insertRun,
  listOutbox,
  listWorkItemBlocks,
  recordLinearInstallation,
  saveRunResult,
  setCurrentRun,
  type Q,
} from "../src/db";
import { createItemReconciler, intakeDelegatedIssue, readyItemsSteps } from "../src/intake";
import { createFakeLinearIssueLifecycle, createFakeTracker } from "../src/linear";
import { Orchestrator } from "../src/loop";
import { eq } from "drizzle-orm";
import { tempHome } from "./helpers";
import { seed } from "./dialects";
import { tempStore } from "./pglite";
import { workspaceAdmission } from "./fake-workspace";

test("task_block holds each dependent", async () => {
  const { db, close } = await tempStore();
  const block = (blocker: string, blocked: string) => (q: Q) =>
    q.orm
      .insert(q.t.taskBlock)
      .values({ blockerLinearIssueId: blocker, blockedLinearIssueId: blocked });
  const queued = (id: string, delegation: string, position: number, session: string) => (q: Q) =>
    q.orm.insert(q.t.workItem).values({
      id,
      delegationId: delegation,
      linearIssueId: id,
      linearIdentifier: id,
      title: id,
      state: "queued",
      branchName: `paws/${id}`,
      position,
      createdAt: 1000,
      sessionKey: session,
    });
  const clock = new FakeClock(1_000);
  const orchestrator = new Orchestrator({
    store: db,
    admission: workspaceAdmission(db),
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
    clock,
    pawsRoot: tempHome(),
    scheduling: async () => ({}),
  });
  let closeReconciler: (() => Promise<void>) | undefined;
  try {
    await seed(
      db,
      queued("hold-0", "hold", 0, "hold-session"),
      queued("hold-1", "hold", 1, "hold-session"),
      (q) =>
        q.orm.insert(q.t.workItem).values({
          id: "stale-1",
          delegationId: "stale",
          linearIssueId: "hold-1",
          linearIdentifier: "stale-1",
          title: "stale",
          state: "cancelled",
          branchName: "paws/stale-1",
          position: 0,
          createdAt: 5000,
        }),
      block("hold-0", "hold-1"),
    );
    const edge = {
      delegationId: "hold",
      blockerLinearIssueId: "hold-0",
      blockedLinearIssueId: "hold-1",
    };
    expect(await listWorkItemBlocks(db)).toEqual([edge]);
    expect(await listWorkItemBlocks(db, "hold")).toEqual([edge]);
    expect(await listWorkItemBlocks(db, "stale")).toEqual([]);

    await orchestrator.reconcileExecution();
    expect(
      await db.run((q) =>
        q.all(q.orm.select({ id: q.t.schedulerAdmission.itemId }).from(q.t.schedulerAdmission)),
      ),
    ).toEqual([{ id: "hold-0" }]);
    expect(await orchestrator.dependencyHandoff("hold-1")).toBeUndefined();
    await confirmFakeMergePg(db, "hold-0");
    await seed(db, (q) =>
      q.orm.update(q.t.workItem).set({ state: "merged" }).where(eq(q.t.workItem.id, "hold-0")),
    );
    const run = await insertRun(db, {
      itemId: "hold-0",
      now: clock.now(),
      status: "ended",
      kind: "implement",
      agent: "codex",
      freshSession: true,
    });
    await saveRunResult(db, run.id, "Published the schema.", clock.now());
    await setCurrentRun(db, "hold-0", run.id);
    expect(await orchestrator.dependencyHandoff("hold-1")).toBe(
      "Completed dependencies:\nhold-0: Published the schema.",
    );

    await seed(
      db,
      queued("notice-0", "notice", 0, "notice-session"),
      queued("notice-1", "notice", 1, "notice-session"),
      block("notice-0", "notice-1"),
    );
    orchestrator.applyDelegationChanges({
      delegationId: "notice",
      sessionId: "notice-session",
      addedItemIds: [],
      removedItemIds: [],
      specChangedItemIds: [],
      canceledItemIds: ["notice-0"],
      parentCanceled: false,
    });
    expect(
      (await listOutbox(db)).some((row) => {
        const body = (row.payload as { body?: string }).body ?? "";
        return body.includes("notice-1") && body.includes("remain held");
      }),
    ).toBe(true);

    const tracker = createFakeTracker([
      {
        linearIssueId: "parent",
        identifier: "DEP-1",
        title: "Parent",
        description: null,
        subIssues: [{ linearIssueId: "b", identifier: "DEP-2", title: "B" }],
      },
    ]);
    const lifecycle = createFakeLinearIssueLifecycle({
      id: "parent",
      teamId: "team",
      stateType: "started",
      assigneeId: null,
      delegateId: null,
    });
    lifecycle.issues.set("b", { ...lifecycle.issue, id: "b" });
    lifecycle.issues.set("outside", { ...lifecycle.issue, id: "outside", stateType: "started" });
    const intake = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "parent",
      now: 1000,
    });
    expect(intake.ok).toBe(true);
    if (!intake.ok) return;
    await seed(db, (q) =>
      q.orm
        .insert(q.t.workspace)
        .values({
          id: "workspace",
          linearOrganizationId: "org",
          name: "Workspace",
          createdAt: 1000,
        })
        .onConflictDoNothing(),
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
      actorId: "owner",
    });
    const blocked = intake.items.find((item) => item.linearIssueId === "b");
    expect(blocked).toBeDefined();
    await seed(db, block("outside", "b"));
    tracker.deps.set("parent", [{ blockerLinearIssueId: "outside", blockedLinearIssueId: "b" }]);
    const reconciler = createItemReconciler({
      store: db,
      tracker,
      lifecycle,
      onChanges: () => syncSteps(() => {}),
    });
    closeReconciler = () => reconciler.close();
    expect(await reconciler.issueChanged({ issueId: "outside", organizationId: "other" })).toEqual(
      [],
    );
    expect(await reconciler.issueChanged({ issueId: "outside", organizationId: "org" })).toEqual([
      { itemId: blocked!.id, workspaceId: "workspace" },
    ]);
    expect(
      (await db.run((q) => readyItemsSteps(q, { itemId: blocked!.id, workspaceId: "workspace" })))
        .readyItemIds,
    ).not.toContain(blocked!.id);
  } finally {
    await closeReconciler?.();
    await orchestrator.shutdown();
    await close();
  }
});
