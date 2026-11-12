import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, asc, count, eq, like, sql } from "drizzle-orm";
import { FakeClock } from "../../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  insertRun,
  saveRunResult,
  setCurrentRun,
  bindLinearSessionTask,
  ensureLinearSession,
  recordLinearInstallation,
  getWorkItem,
  type Db,
} from "../../src/db";
import { Orchestrator } from "../../src/loop";
import { readyItemsSteps, syncItemDependencies } from "../../src/intake";
import { createFakeTracker, createFakeLinearIssueLifecycle } from "../../src/linear";
import { confirmFakeMergePg, workspaceAdmission } from "../fake-workspace";
import { tempStore } from "../pglite";

const pendingStarts = async (db: Db) =>
  (await db.run((q) =>
    q.one(
      q.orm
        .select({ n: count() })
        .from(q.t.job)
        .where(and(eq(q.t.job.queue, "item.start"), eq(q.t.job.status, "pending"))),
    ),
  ))!.n;

export async function probeExecutionLifecycle(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const clock = new FakeClock(1000);
  const store = await tempStore();
  const db = store.db;
  const create = (scheduling?: () => Promise<object>) =>
    new Orchestrator({
      store: db,
      admission: workspaceAdmission(db),
      jobs: new JobLoop(db, clock),
      outbox: new OutboxDispatcher(db, clock),
      clock,
      pawsRoot: root,
      scheduling,
      tracker: createFakeTracker(),
    });
  let orchestrator = create();
  const state = async (id: string) => {
    const items = await db.run((q) =>
      q.all(
        q.orm
          .select({ state: q.t.workItem.state })
          .from(q.t.workItem)
          .where(eq(q.t.workItem.delegationId, id))
          .orderBy(asc(q.t.workItem.position), asc(q.t.workItem.id)),
      ),
    );
    if (
      items.length > 0 &&
      items.every(
        (item) =>
          item.state === "merged" || item.state === "completed" || item.state === "cancelled",
      )
    )
      return items.every((item) => item.state === "cancelled") ? "cancelled" : "done";
    return "running";
  };
  const seed = (id: string, states: string[]) =>
    db.run((q) =>
      q.exec(
        q.orm.insert(q.t.workItem).values(
          states.map((itemState, index) => ({
            id: `${id}-${index}`,
            delegationId: id,
            linearIssueId: `${id}-${index}`,
            linearIdentifier: `${id}-${index}`,
            title: id,
            state: itemState,
            branchName: `paws/${id}-${index}`,
            position: index,
            createdAt: clock.now(),
            sessionKey: `${id}-session`,
          })),
        ),
      ),
    );
  const notices = async (id: string) =>
    (await db.run((q) =>
      q.one(
        q.orm
          .select({ n: count() })
          .from(q.t.outbox)
          .where(like(q.t.outbox.idempotencyKey, `epic-stalled:${id}:%`)),
      ),
    ))!.n;
  try {
    await seed("mixed", ["merged", "cancelled", "completed"]);
    await seed("abandoned", ["cancelled", "cancelled"]);
    await seed("already-stalled", ["merged"]);
    await seed("failed", ["failed"]);
    await orchestrator.reconcileExecution();
    observe(
      "mixed completed and cancelled work finishes the epic",
      (await state("mixed")) === "done",
      await state("mixed"),
    );
    observe(
      "every cancelled item cancels the epic",
      (await state("abandoned")) === "cancelled",
      await state("abandoned"),
    );
    observe(
      "a stalled epic can finish after its last blocker completes",
      (await state("already-stalled")) === "done",
      await state("already-stalled"),
    );
    observe(
      "failed work never counts as successful epic completion",
      (await state("failed")) === "running",
      await state("failed"),
    );
    clock.advance(10 * 60 * 1000);
    await orchestrator.reconcileExecution();
    const stallQuestions = (await db.run((q) =>
      q.one(
        q.orm
          .select({ n: count() })
          .from(q.t.question)
          .where(like(q.t.question.body, "%made no progress%")),
      ),
    ))!.n;
    observe(
      "a held item no longer produces a stall question after ten minutes",
      (await state("failed")) === "running" &&
        (await notices("failed")) === 0 &&
        stallQuestions === 0,
      { state: await state("failed"), notices: await notices("failed"), stallQuestions },
    );
    await seed("handoff", ["merged", "queued"]);
    await confirmFakeMergePg(db, "handoff-0");
    await db.run((q) =>
      q.exec(
        q.orm
          .insert(q.t.taskBlock)
          .values({ blockerLinearIssueId: "handoff-0", blockedLinearIssueId: "handoff-1" }),
      ),
    );
    const run = await insertRun(db, {
      itemId: "handoff-0",
      now: clock.now(),
      status: "ended",
      kind: "implement",
      agent: "codex",
      freshSession: true,
    });
    await saveRunResult(db, run.id, "Published the exact API schema.", clock.now());
    await setCurrentRun(db, "handoff-0", run.id);
    assert.equal(
      await orchestrator.dependencyHandoff("handoff-1"),
      "Completed dependencies:\nhandoff-0: Published the exact API schema.",
    );
    await orchestrator.reconcileExecution();
    await orchestrator.reconcileExecution();
    const starts = await db.run((q) =>
      q.all(
        q.orm
          .select({ payload: q.t.job.payload })
          .from(q.t.job)
          .where(
            and(
              eq(q.t.job.queue, "item.start"),
              eq(sql`${q.t.job.payload}->>'itemId'`, "handoff-1"),
            ),
          ),
      ),
    );
    observe(
      "dependency completion schedules once with the completed result",
      starts.length === 1 &&
        (starts[0]!.payload as { handoff?: string }).handoff ===
          (await orchestrator.dependencyHandoff("handoff-1")),
      starts,
    );
    await db.run((q) =>
      q.exec(
        q.orm
          .update(q.t.run)
          .set({ checkpoint: sql`'null'::jsonb` })
          .where(eq(q.t.run.id, run.id)),
      ),
    );
    observe(
      "a valid JSON null dependency checkpoint falls back to completion",
      (await orchestrator.dependencyHandoff("handoff-1")) ===
        "Completed dependencies:\nhandoff-0: Completed.",
      await orchestrator.dependencyHandoff("handoff-1"),
    );
    await seed("external", ["queued"]);
    await db.run((q) =>
      q.exec(
        q.orm.insert(q.t.workspace).values({
          id: "external-workspace",
          linearOrganizationId: "external-org",
          name: "External workspace",
          createdAt: 1,
        }),
      ),
    );
    await ensureLinearSession(db, {
      sessionId: "external-session",
      issueId: "external-parent",
      organizationId: "external-org",
      appUserId: "external-app",
      creatorId: "external-human",
    });
    await bindLinearSessionTask(db, "external-session", "external");
    await recordLinearInstallation(db, {
      sessionId: "external-session",
      organizationId: "external-org",
      oauthClientId: "external-client",
      appUserId: "external-app",
      teamId: "external-team",
      observedAtMs: clock.now(),
    });
    const tracker = createFakeTracker();
    tracker.deps.set("external-parent", [
      { blockerLinearIssueId: "outside", blockedLinearIssueId: "external-0" },
    ]);
    const lifecycle = createFakeLinearIssueLifecycle({
      id: "outside",
      teamId: "external-team",
      stateType: "started",
      assigneeId: "external-human",
      delegateId: "external-app",
    });
    await syncItemDependencies(db, {
      itemId: "external-0",
      workspaceId: "external-workspace",
      expectedGeneration: (
        await db.run((q) =>
          readyItemsSteps(q, {
            itemId: "external-0",
            workspaceId: "external-workspace",
          }),
        )
      ).generation,
      tracker,
      lifecycle,
    });
    await orchestrator.reconcileExecution();
    clock.advance(600000);
    await orchestrator.reconcileExecution();
    observe(
      "in-progress external work does not produce a human stalled question",
      (await state("external")) === "running" && (await notices("external")) === 0,
      { state: await state("external"), notices: await notices("external") },
    );
    await orchestrator.shutdown();
    orchestrator = create(async () => ({}));
    await seed("unrelated-active", ["running"]);
    await orchestrator.reconcileExecution();
    const admitted = (
      await db.run((q) =>
        q.all(q.orm.select({ itemId: q.t.schedulerAdmission.itemId }).from(q.t.schedulerAdmission)),
      )
    ).map((row) => row.itemId);
    observe(
      "configured scheduling runs despite unrelated active work",
      admitted.includes("handoff-1"),
      admitted,
    );
    await orchestrator.shutdown();
    const guardStore = await tempStore();
    const guardDb = guardStore.db;
    const guardJobs = new JobLoop(guardDb, clock);
    let allowed = true;
    const guard = new Orchestrator({
      store: guardDb,
      jobs: guardJobs,
      outbox: new OutboxDispatcher(guardDb, clock),
      clock,
      pawsRoot: join(root, "admission"),
      admission: workspaceAdmission(guardDb, { authority: () => allowed }),
    });
    try {
      await guardDb.run((q) =>
        q.exec(
          q.orm.insert(q.t.workItem).values({
            id: "guard-item",
            delegationId: "guard",
            linearIssueId: "guard",
            linearIdentifier: "G-1",
            title: "Guard",
            state: "queued",
            branchName: "paws/guard",
            position: 0,
            createdAt: 1,
          }),
        ),
      );
      await guard.reconcileExecution();
      allowed = false;
      await guard.reconcileExecution();
      await guardJobs.tick();
      await guard.reconcileExecution();
      const held = await pendingStarts(guardDb);
      allowed = true;
      await guard.reconcileExecution();
      await guard.reconcileExecution();
      const resumed = await pendingStarts(guardDb);
      observe(
        "a skipped start can be admitted once after reconciliation clears",
        held === 0 &&
          resumed === 1 &&
          (await getWorkItem(guardDb, "guard-item"))?.state === "queued",
        { held, resumed },
      );
    } finally {
      await guard.shutdown();
      await guardStore.close();
    }
  } finally {
    await orchestrator.shutdown();
    await store.close();
  }
}

if (import.meta.main) {
  const root = process.argv[2];
  if (!root) throw new Error("Provide a disposable proof directory");
  const observations: unknown[] = [];
  await probeExecutionLifecycle(root, (name, passed, observed) => {
    observations.push({ name, passed, observed });
    writeFileSync(join(root, "observations.json"), JSON.stringify(observations, null, 2));
    assert(passed, name);
  });
  console.log(JSON.stringify({ root, observations: observations.length }));
}
