import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeClock, JOB_KIND, WORK_ITEM_STATES } from "../../src/core";
import {
  bindLinearSessionTask,
  enqueueJob,
  ensureLinearSession,
  getWorkItem,
  immediate,
  insertRun,
  JobLoop,
  migrate,
  openDatabase,
  OutboxDispatcher,
  saveCheckpoint,
  saveTaskMode,
  setCurrentRun,
} from "../../src/db";
import { createFakeTracker } from "../../src/linear";
import { Orchestrator, type ExecutionChanges } from "../../src/loop";
import { openQuestion } from "../../src/questions";
import type { RunAgentOptions, RunAgentResult } from "../../src/acp";

export async function probeExecutionChanges(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const db = openDatabase(join(root, "paws.sqlite"));
  migrate(db);
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
    closeoutForItem: () => {
      throw new Error("Unexpected verification call");
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
    db,
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
  const changes = (epicId: string, patch: Partial<ExecutionChanges> = {}): ExecutionChanges => ({
    epicId,
    sessionId: `${epicId}-session`,
    addedItemIds: [],
    removedItemIds: [],
    specChangedItemIds: [],
    canceledItemIds: [],
    parentCanceled: false,
    ...patch,
  });
  const seed = (id: string, states: readonly string[]) => {
    db.run(
      "INSERT INTO epic(id,linear_issue_id,linear_identifier,title,state,created_at) VALUES(?,?,?,?,?,?)",
      [id, id, id, id, "running", clock.now()],
    );
    ensureLinearSession(db, { sessionId: `${id}-session`, issueId: id, now: clock.now() });
    bindLinearSessionTask(db, `${id}-session`, id);
    states.forEach((state, index) =>
      db.run(
        "INSERT INTO work_item(id,epic_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at,session_key) VALUES(?,?,?,?,?,?,?,?,?,?)",
        [
          `${id}-${index}`,
          id,
          `${id}-${index}`,
          `${id}-${index}`,
          id,
          state,
          `paws/${id}-${index}`,
          index,
          clock.now(),
          `${id}-session`,
        ],
      ),
    );
  };
  try {
    seed("criteria", ["merge_queue", "awaiting_signoff", "paused", "merged", "queued"]);
    saveCheckpoint(db, "criteria-2", {
      phase: "running",
      wipCommit: "paused-existing-work",
      baseSha: "previous-base",
    });
    const oldStart = enqueueJob(db, {
      queue: JOB_KIND.start,
      payload: { itemId: "criteria-4" },
      jobKey: "start:criteria-4:0",
      now: clock.now(),
    });
    const run = insertRun(db, {
      itemId: "criteria-0",
      kind: "implement",
      agent: "codex",
      status: "active",
      freshSession: true,
      now: clock.now(),
    });
    setCurrentRun(db, "criteria-0", run.id);
    saveCheckpoint(db, "criteria-0", { phase: "merge_queue", wipCommit: "old-verified-candidate" });
    const oldJob = enqueueJob(db, {
      queue: JOB_KIND.merge,
      payload: { itemId: "criteria-0", head: "old-verified-candidate" },
      jobKey: "old-approval",
      now: clock.now(),
    });
    const question = openQuestion(db, {
      itemId: "criteria-1",
      sessionId: "criteria-session",
      body: "Old criteria signoff?",
      now: clock.now(),
    });
    const changed = changes("criteria", {
      specChangedItemIds: ["criteria-0", "criteria-1", "criteria-2", "criteria-3", "criteria-4"],
    });
    assert.throws(() =>
      immediate(db, () => {
        orchestrator.applyEpicChanges(changed);
        throw new Error("Force atomic publication rollback");
      }),
    );
    observe(
      "criteria effects roll back with their brief publication",
      getWorkItem(db, "criteria-0")?.state === "merge_queue" &&
        db.query<{ status: string }, [number]>("SELECT status FROM job WHERE id=?").get(oldJob)
          ?.status === "pending",
      getWorkItem(db, "criteria-0"),
    );
    orchestrator.applyEpicChanges(changed);
    observe(
      "criteria edits atomically retire old approval and candidate identity",
      getWorkItem(db, "criteria-0")?.state === "queued" &&
        getWorkItem(db, "criteria-0")?.checkpoint === null &&
        getWorkItem(db, "criteria-0")?.currentRunId === null &&
        db.query<{ status: string }, [number]>("SELECT status FROM job WHERE id=?").get(oldJob)
          ?.status === "cancelled" &&
        db.query<{ status: string }, [string]>("SELECT status FROM run WHERE id=?").get(run.id)
          ?.status === "lost",
      getWorkItem(db, "criteria-0"),
    );
    observe(
      "criteria edits withdraw stale signoff but preserve explicit pause and merged work",
      getWorkItem(db, "criteria-1")?.state === "queued" &&
        getWorkItem(db, "criteria-2")?.state === "paused" &&
        getWorkItem(db, "criteria-3")?.state === "merged" &&
        db
          .query<{ cancelled_at: number | null }, [string]>(
            "SELECT cancelled_at FROM question WHERE id=?",
          )
          .get(question.id)?.cancelled_at === clock.now(),
      [getWorkItem(db, "criteria-1"), getWorkItem(db, "criteria-2"), getWorkItem(db, "criteria-3")],
    );
    observe(
      "queued criteria advance their task version and paused edits preserve WIP",
      getWorkItem(db, "criteria-4")?.version === 1 &&
        db.query<{ status: string }, [number]>("SELECT status FROM job WHERE id=?").get(oldStart)
          ?.status === "cancelled" &&
        getWorkItem(db, "criteria-2")?.checkpoint?.wipCommit === "paused-existing-work",
      { queued: getWorkItem(db, "criteria-4"), paused: getWorkItem(db, "criteria-2") },
    );
    await orchestrator.finishEpicChanges(changed);
    observe(
      "postcommit joining does not prematurely enqueue revised work",
      db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM job WHERE queue='item.start' AND status='pending'",
        )
        .get()?.n === 0,
      cancelReceipts,
    );
    seed("added", ["queued"]);
    orchestrator.applyEpicChanges(changes("added", { addedItemIds: ["added-0"] }));
    observe(
      "new subissues enter canonical repository-backed code mode",
      db
        .query<{ mode: string; repository_context: number }, []>(
          "SELECT mode,repository_context FROM work_item_task WHERE item_id='added-0'",
        )
        .get()?.repository_context === 1,
      "added-0",
    );
    const activeStates = WORK_ITEM_STATES.filter(
      (state) => !["merged", "completed", "cancelled"].includes(state),
    );
    seed("cancel", activeStates);
    orchestrator.applyEpicChanges(changes("cancel", { parentCanceled: true }));
    observe(
      "epic cancellation cascades through every nonterminal state",
      activeStates.every((_, index) => getWorkItem(db, `cancel-${index}`)?.state === "cancelled"),
      activeStates,
    );
    seed("blocker", ["queued", "queued"]);
    db.run(
      "INSERT INTO work_item_block(epic_id,blocker_linear_issue_id,blocked_linear_issue_id) VALUES('blocker','blocker-0','blocker-1')",
    );
    orchestrator.applyEpicChanges(changes("blocker", { canceledItemIds: ["blocker-0"] }));
    observe(
      "cancelled blockers leave dependents held with a Linear explanation",
      getWorkItem(db, "blocker-1")?.state === "queued" &&
        db
          .query<{ n: number }, []>(
            "SELECT COUNT(*) AS n FROM outbox WHERE idempotency_key LIKE 'cancelled-blocker:blocker-0:%'",
          )
          .get()?.n === 1,
      getWorkItem(db, "blocker-1"),
    );
    assert.throws(
      () => orchestrator.applyEpicChanges(changes("cancel", { specChangedItemIds: ["added-0"] })),
      /ownership/,
    );
    observe(
      "cross-epic callbacks reject without changing the other task",
      getWorkItem(db, "added-0")?.state === "queued",
      getWorkItem(db, "added-0"),
    );
    db.run("UPDATE work_item SET state='cancelled' WHERE state IN ('queued','paused')");
    seed("pause", ["queued"]);
    saveTaskMode(db, "pause-0", "answer");
    saveCheckpoint(db, "pause-0", { phase: "running", wipCommit: "preserved-commit" });
    enqueueJob(db, {
      queue: JOB_KIND.start,
      payload: { itemId: "pause-0" },
      jobKey: "pause-proof",
      now: clock.now(),
    });
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
      paused && portJoined && getWorkItem(db, "pause-0")?.state === "paused",
      { paused, portStarted, portJoined, cancelReceipts },
    );
    const resumed = await orchestrator.resumeItem("pause-0");
    observe(
      "resume preserves branch checkpoint and supplies its context to fresh dispatch",
      resumed &&
        getWorkItem(db, "pause-0")?.state === "queued" &&
        getWorkItem(db, "pause-0")?.checkpoint?.wipCommit === "preserved-commit" &&
        orchestrator.dependencyHandoff("pause-0")?.includes("preserved-commit") === true,
      getWorkItem(db, "pause-0"),
    );
    observe(
      "pause refuses nonrunning tasks",
      !(await orchestrator.pauseItem("pause-0")),
      getWorkItem(db, "pause-0")?.state,
    );
  } finally {
    await orchestrator.shutdown();
    db.close();
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
