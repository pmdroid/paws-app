import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, count, eq, inArray, like } from "drizzle-orm";
import { FakeClock, JOB_KIND, WORK_ITEM_STATES } from "../../src/core";
import {
  bindLinearSessionTask,
  enqueueJob,
  ensureLinearSession,
  getWorkItem,
  insertRun,
  JobLoop,
  OutboxDispatcher,
  saveCheckpoint,
  saveTaskMode,
  setCurrentRun,
} from "../../src/db";
import { createFakeTracker } from "../../src/linear";
import { Orchestrator, type ExecutionChanges } from "../../src/loop";
import { openQuestion } from "../../src/questions";
import type { RunAgentOptions, RunAgentResult } from "../../src/acp";
import { workspaceAdmission } from "../fake-workspace";
import { tempStore } from "../pglite";

export async function probeExecutionChanges(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const store = await tempStore();
  const db = store.db;
  const jobStatus = async (id: number) =>
    (
      await db.run((q) =>
        q.one(q.orm.select({ status: q.t.job.status }).from(q.t.job).where(eq(q.t.job.id, id))),
      )
    )?.status;
  const clock = new FakeClock(1000);
  const tracker = createFakeTracker();
  const jobs = new JobLoop(db, clock);
  let portStarted = false;
  let portJoined = false;
  let cancelReceipts = 0;
  const remote = {
    agentForSession: () => {
      throw new Error("Unexpected helper call");
    },
    agentForItem:
      () =>
      async (options: RunAgentOptions): Promise<RunAgentResult> => {
        portStarted = true;
        await new Promise<void>((resolve) => {
          const finish = () =>
            setTimeout(() => {
              portJoined = true;
              resolve();
            }, 10);
          if (options.signal?.aborted) finish();
          else options.signal?.addEventListener("abort", finish, { once: true });
        });
        return {
          role: options.role,
          stopReason: "cancelled",
          cancelled: true,
          timedOut: false,
          authRequired: false,
          agentExited: true,
        };
      },
    async cancelItem() {
      cancelReceipts += 1;
    },
  };
  const orchestrator = new Orchestrator({
    store: db,
    admission: workspaceAdmission(db),
    jobs,
    outbox: new OutboxDispatcher(db, clock),
    clock,
    pawsRoot: root,
    tracker,
    linearTaskModes: true,
    remoteExecution: remote,
    launch: () => {
      throw new Error("Local agent launch is forbidden");
    },
  });
  const changes = (
    delegationId: string,
    patch: Partial<ExecutionChanges> = {},
  ): ExecutionChanges => ({
    delegationId,
    sessionId: `${delegationId}-session`,
    addedItemIds: [],
    removedItemIds: [],
    specChangedItemIds: [],
    canceledItemIds: [],
    parentCanceled: false,
    ...patch,
  });
  const seed = async (id: string, states: readonly string[]) => {
    await ensureLinearSession(db, {
      sessionId: `${id}-session`,
      issueId: id,
      now: clock.now(),
    });
    await bindLinearSessionTask(db, `${id}-session`, id);
    await db.run((q) =>
      q.exec(
        q.orm.insert(q.t.workItem).values(
          states.map((state, index) => ({
            id: `${id}-${index}`,
            delegationId: id,
            linearIssueId: `${id}-${index}`,
            linearIdentifier: `${id}-${index}`,
            title: id,
            state,
            branchName: `paws/${id}-${index}`,
            position: index,
            createdAt: clock.now(),
            sessionKey: `${id}-session`,
          })),
        ),
      ),
    );
  };
  try {
    await seed("criteria", ["merge_queue", "awaiting_input", "paused", "merged", "queued"]);
    await saveCheckpoint(db, "criteria-2", {
      phase: "running",
      wipCommit: "paused-existing-work",
      baseSha: "previous-base",
    });
    const oldStart = await enqueueJob(db, {
      queue: JOB_KIND.start,
      payload: { itemId: "criteria-4" },
      jobKey: "start:criteria-4:0",
      now: clock.now(),
    });
    const run = await insertRun(db, {
      itemId: "criteria-0",
      kind: "implement",
      agent: "codex",
      status: "active",
      freshSession: true,
      now: clock.now(),
    });
    await setCurrentRun(db, "criteria-0", run.id);
    await saveCheckpoint(db, "criteria-0", {
      phase: "merge_queue",
      wipCommit: "old-verified-candidate",
    });
    const oldJob = await enqueueJob(db, {
      queue: JOB_KIND.merge,
      payload: { itemId: "criteria-0", head: "old-verified-candidate" },
      jobKey: "old-approval",
      now: clock.now(),
    });
    const question = await openQuestion(db, {
      itemId: "criteria-1",
      sessionId: "criteria-session",
      body: "Old criteria signoff?",
      now: clock.now(),
    });
    const changed = changes("criteria", {
      specChangedItemIds: ["criteria-0", "criteria-1", "criteria-2", "criteria-3", "criteria-4"],
    });
    await assert.rejects(
      db.transaction(function* (q) {
        yield* orchestrator.applyDelegationChangesSteps(q, changed);
        throw new Error("Force atomic publication rollback");
      }),
    );
    observe(
      "criteria effects roll back with their brief publication",
      (await getWorkItem(db, "criteria-0"))?.state === "merge_queue" &&
        (await jobStatus(oldJob)) === "pending",
      await getWorkItem(db, "criteria-0"),
    );
    await orchestrator.applyDelegationChanges(changed);
    observe(
      "criteria edits atomically retire old approval and candidate identity",
      (await getWorkItem(db, "criteria-0"))?.state === "queued" &&
        (await getWorkItem(db, "criteria-0"))?.checkpoint?.phase === "running" &&
        (await getWorkItem(db, "criteria-0"))?.currentRunId === run.id &&
        (await jobStatus(oldJob)) === "cancelled" &&
        (
          await db.run((q) =>
            q.one(
              q.orm.select({ status: q.t.run.status }).from(q.t.run).where(eq(q.t.run.id, run.id)),
            ),
          )
        )?.status === "ended",
      await getWorkItem(db, "criteria-0"),
    );
    observe(
      "criteria edits withdraw stale signoff but preserve explicit pause and merged work",
      (await getWorkItem(db, "criteria-1"))?.state === "queued" &&
        (await getWorkItem(db, "criteria-2"))?.state === "paused" &&
        (await getWorkItem(db, "criteria-3"))?.state === "merged" &&
        (
          await db.run((q) =>
            q.one(
              q.orm
                .select({ cancelledAt: q.t.question.cancelledAt })
                .from(q.t.question)
                .where(eq(q.t.question.id, question.id)),
            ),
          )
        )?.cancelledAt === clock.now(),
      [
        await getWorkItem(db, "criteria-1"),
        await getWorkItem(db, "criteria-2"),
        await getWorkItem(db, "criteria-3"),
      ],
    );
    observe(
      "queued criteria advance their task version and paused edits preserve WIP",
      (await getWorkItem(db, "criteria-4"))!.version > 0 &&
        (await jobStatus(oldStart)) === "cancelled" &&
        (await getWorkItem(db, "criteria-2"))?.checkpoint?.wipCommit === "paused-existing-work",
      {
        queued: await getWorkItem(db, "criteria-4"),
        paused: await getWorkItem(db, "criteria-2"),
      },
    );
    await orchestrator.finishDelegationChanges(changed);
    observe(
      "postcommit joining does not prematurely enqueue revised work",
      (
        await db.run((q) =>
          q.one(
            q.orm
              .select({ n: count() })
              .from(q.t.job)
              .where(and(eq(q.t.job.queue, "item.start"), eq(q.t.job.status, "pending"))),
          ),
        )
      )?.n === 0,
      cancelReceipts,
    );
    await seed("added", ["queued"]);
    await orchestrator.applyDelegationChanges(changes("added", { addedItemIds: ["added-0"] }));
    observe(
      "new subissues enter canonical repository-backed code mode",
      (
        await db.run((q) =>
          q.one(
            q.orm
              .select({ repositoryContext: q.t.workItemTask.repositoryContext })
              .from(q.t.workItemTask)
              .where(eq(q.t.workItemTask.itemId, "added-0")),
          ),
        )
      )?.repositoryContext === 1,
      "added-0",
    );
    const activeStates = WORK_ITEM_STATES.filter(
      (state) => !["merged", "completed", "cancelled"].includes(state),
    );
    await seed("cancel", activeStates);
    await orchestrator.applyDelegationChanges(changes("cancel", { parentCanceled: true }));
    const cancelledStates = await Promise.all(
      activeStates.map(async (_, index) => (await getWorkItem(db, `cancel-${index}`))?.state),
    );
    observe(
      "epic cancellation cascades through every nonterminal state",
      cancelledStates.every((state) => state === "cancelled"),
      activeStates,
    );
    await seed("blocker", ["queued", "queued"]);
    await db.run((q) =>
      q.exec(
        q.orm
          .insert(q.t.taskBlock)
          .values({ blockerLinearIssueId: "blocker-0", blockedLinearIssueId: "blocker-1" }),
      ),
    );
    await orchestrator.applyDelegationChanges(
      changes("blocker", { canceledItemIds: ["blocker-0"] }),
    );
    observe(
      "cancelled blockers leave dependents held with a Linear explanation",
      (await getWorkItem(db, "blocker-1"))?.state === "queued" &&
        (
          await db.run((q) =>
            q.one(
              q.orm
                .select({ n: count() })
                .from(q.t.outbox)
                .where(like(q.t.outbox.idempotencyKey, "cancelled-blocker:blocker-0:%")),
            ),
          )
        )?.n === 1,
      await getWorkItem(db, "blocker-1"),
    );
    await assert.rejects(
      () =>
        orchestrator.applyDelegationChanges(changes("cancel", { specChangedItemIds: ["added-0"] })),
      /ownership/,
    );
    observe(
      "cross-epic callbacks reject without changing the other task",
      (await getWorkItem(db, "added-0"))?.state === "queued",
      await getWorkItem(db, "added-0"),
    );
    await db.run((q) =>
      q.exec(
        q.orm
          .update(q.t.workItem)
          .set({ state: "cancelled" })
          .where(inArray(q.t.workItem.state, ["queued", "paused"])),
      ),
    );
    await seed("pause", ["queued"]);
    await saveTaskMode(db, "pause-0", "answer");
    await saveCheckpoint(db, "pause-0", {
      phase: "running",
      wipCommit: "preserved-commit",
    });
    const pauseJob = await enqueueJob(db, {
      queue: JOB_KIND.start,
      payload: { itemId: "pause-0" },
      jobKey: "pause-proof",
      now: clock.now(),
    });
    await db.run((q) =>
      q.exec(
        q.orm.insert(q.t.schedulerAdmission).values({
          itemId: "pause-0",
          jobId: pauseJob,
          projectKey: "*",
          repositoryKey: "fixture",
          paths: [],
          hot: 0,
          createdAt: clock.now(),
        }),
      ),
    );
    const pending = (async () => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await jobs.tick();
        if (portStarted) return;
      }
    })();
    const deadline = performance.now() + 3000;
    while (performance.now() < deadline) {
      if (portStarted) break;
      await Bun.sleep(5);
    }
    assert(portStarted, "Selected remote answer port must actually start");
    const paused = await orchestrator.pauseItem("pause-0");
    await pending;
    observe(
      "pause joins the selected remote agent before returning",
      paused && portJoined && (await getWorkItem(db, "pause-0"))?.state === "paused",
      { paused, portStarted, portJoined, cancelReceipts },
    );
    const resumed = await orchestrator.resumeItem("pause-0");
    observe(
      "resume preserves branch checkpoint and supplies its context to fresh dispatch",
      resumed &&
        (await getWorkItem(db, "pause-0"))?.state === "queued" &&
        (await getWorkItem(db, "pause-0"))?.checkpoint?.wipCommit === "preserved-commit" &&
        (await orchestrator.dependencyHandoff("pause-0"))?.includes("preserved-commit") === true,
      await getWorkItem(db, "pause-0"),
    );
    observe(
      "pause refuses nonrunning tasks",
      !(await orchestrator.pauseItem("pause-0")),
      (await getWorkItem(db, "pause-0"))?.state,
    );
  } finally {
    await orchestrator.shutdown();
    await store.close();
  }
}

if (import.meta.main) {
  const root = process.argv[2];
  if (!root) throw new Error("Provide a disposable proof directory");
  const observations: unknown[] = [];
  await probeExecutionChanges(root, (name, passed, observed) => {
    observations.push({ name, passed, observed });
    writeFileSync(join(root, "observations.json"), JSON.stringify(observations, null, 2));
    assert(passed, name);
  });
  console.log(JSON.stringify({ root, observations: observations.length }));
}
