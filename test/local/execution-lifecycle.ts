import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeClock } from "../../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  insertRun,
  migrate,
  openDatabase,
  saveRunResult,
  setCurrentRun,
  bindLinearSessionTask,
  ensureLinearSession,
  recordLinearInstallation,
  getWorkItem,
} from "../../src/db";
import { Orchestrator } from "../../src/loop";
import { syncEpicDependencies } from "../../src/intake";
import { createFakeTracker, createFakeLinearIssueLifecycle } from "../../src/linear";

export async function probeExecutionLifecycle(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const clock = new FakeClock(1000);
  const db = openDatabase(join(root, "paws.sqlite"));
  migrate(db);
  const create = (
    dispatchReady?: (input: { legacyReadyItemIds: readonly string[] }) => void,
    channel?: "comments",
  ) =>
    new Orchestrator({
      db,
      jobs: new JobLoop(db, clock),
      outbox: new OutboxDispatcher(db, clock),
      clock,
      pawsRoot: root,
      dispatchReady,
      channel,
      tracker: createFakeTracker(),
    });
  let orchestrator = create();
  const state = (id: string) =>
    db.query<{ state: string }, [string]>("SELECT state FROM epic WHERE id=?").get(id)?.state;
  const seed = (id: string, states: string[], epicState = "running") => {
    db.run(
      "INSERT INTO epic(id,linear_issue_id,linear_identifier,title,state,created_at) VALUES(?,?,?,?,?,?)",
      [id, `${id}-parent`, `${id}-parent`, id, epicState, clock.now()],
    );
    states.forEach((itemState, index) =>
      db.run(
        "INSERT INTO work_item(id,epic_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at,session_key) VALUES(?,?,?,?,?,?,?,?,?,?)",
        [
          `${id}-${index}`,
          id,
          `${id}-${index}`,
          `${id}-${index}`,
          id,
          itemState,
          `paws/${id}-${index}`,
          index,
          clock.now(),
          `${id}-session`,
        ],
      ),
    );
  };
  const notices = (id: string) =>
    db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM outbox WHERE idempotency_key LIKE ?",
      )
      .get(`epic-stalled:${id}:%`)!.n;
  try {
    seed("mixed", ["merged", "cancelled", "completed"]);
    seed("abandoned", ["cancelled", "cancelled"]);
    seed("already-stalled", ["merged"], "stalled");
    seed("failed", ["failed"]);
    orchestrator.reconcileExecution();
    observe(
      "mixed completed and cancelled work finishes the epic",
      state("mixed") === "done",
      state("mixed"),
    );
    observe(
      "every cancelled item cancels the epic",
      state("abandoned") === "cancelled",
      state("abandoned"),
    );
    observe(
      "a stalled epic can finish after its last blocker completes",
      state("already-stalled") === "done",
      state("already-stalled"),
    );
    observe(
      "failed work never counts as successful epic completion",
      state("failed") === "running",
      state("failed"),
    );
    clock.advance(10 * 60 * 1000);
    orchestrator.reconcileExecution();
    const stallQuestions = db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM question WHERE body LIKE '%made no progress%'",
      )
      .get()!.n;
    observe(
      "a held item no longer produces a stall question after ten minutes",
      state("failed") === "running" && notices("failed") === 0 && stallQuestions === 0,
      { state: state("failed"), notices: notices("failed"), stallQuestions },
    );
    seed("handoff", ["merged", "queued"]);
    db.run(
      "INSERT INTO work_item_block(epic_id,blocker_linear_issue_id,blocked_linear_issue_id) VALUES('handoff','handoff-0','handoff-1')",
    );
    const run = insertRun(db, {
      itemId: "handoff-0",
      now: clock.now(),
      status: "ended",
      kind: "implement",
      agent: "codex",
      freshSession: true,
    });
    saveRunResult(db, run.id, "Published the exact API schema.", clock.now());
    setCurrentRun(db, "handoff-0", run.id);
    assert.equal(
      orchestrator.dependencyHandoff("handoff-1"),
      "Completed dependencies:\nhandoff-0: Published the exact API schema.",
    );
    orchestrator.reconcileExecution();
    orchestrator.reconcileExecution();
    const starts = db
      .query<{ payload: string }, []>(
        "SELECT payload FROM job WHERE job_key LIKE 'start:handoff-1%'",
      )
      .all();
    observe(
      "dependency completion schedules once with the completed result",
      starts.length === 1 &&
        JSON.parse(starts[0]!.payload).handoff === orchestrator.dependencyHandoff("handoff-1"),
      starts,
    );
    db.run("UPDATE run SET checkpoint='null' WHERE id=?", [run.id]);
    observe(
      "a valid JSON null dependency checkpoint falls back to completion",
      orchestrator.dependencyHandoff("handoff-1") ===
        "Completed dependencies:\nhandoff-0: Completed.",
      orchestrator.dependencyHandoff("handoff-1"),
    );
    seed("external", ["queued"]);
    db.run(
      "INSERT INTO workspace(id,linear_organization_id,name,created_at) VALUES('external-workspace','external-org','External workspace',1)",
    );
    ensureLinearSession(db, {
      sessionId: "external-session",
      issueId: "external-parent",
      organizationId: "external-org",
      appUserId: "external-app",
      creatorId: "external-human",
    });
    bindLinearSessionTask(db, "external-session", "external");
    recordLinearInstallation(db, {
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
    await syncEpicDependencies(db, {
      epicId: "external",
      workspaceId: "external-workspace",
      expectedGeneration: 0,
      tracker,
      lifecycle,
    });
    orchestrator.reconcileExecution();
    clock.advance(600000);
    orchestrator.reconcileExecution();
    observe(
      "in-progress external work does not produce a human stalled question",
      state("external") === "running" && notices("external") === 0,
      { state: state("external"), notices: notices("external") },
    );
    await orchestrator.shutdown();
    const captured: string[][] = [];
    orchestrator = create(({ legacyReadyItemIds }) => captured.push([...legacyReadyItemIds]));
    seed("unrelated-active", ["running"]);
    orchestrator.reconcileExecution();
    observe(
      "configured scheduling runs despite unrelated active work",
      captured.at(-1)?.includes("handoff-1") === true,
      captured,
    );
    await orchestrator.shutdown();
    const guardDb = openDatabase(join(root, "admission.sqlite"));
    migrate(guardDb);
    const guardJobs = new JobLoop(guardDb, clock);
    let allowed = true;
    const guard = new Orchestrator({
      db: guardDb,
      jobs: guardJobs,
      outbox: new OutboxDispatcher(guardDb, clock),
      clock,
      pawsRoot: join(root, "admission"),
      canDispatchEpic: () => allowed,
    });
    try {
      guardDb.run(
        "INSERT INTO epic(id,linear_issue_id,linear_identifier,title,state,created_at) VALUES('guard','guard','G-1','Guard','running',1)",
      );
      guardDb.run(
        "INSERT INTO work_item(id,epic_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at) VALUES('guard-item','guard','guard','G-1','Guard','queued','paws/guard',0,1)",
      );
      guard.reconcileExecution();
      allowed = false;
      await guardJobs.tick();
      guard.reconcileExecution();
      const held = guardDb
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM job WHERE queue='item.start' AND status='pending'",
        )
        .get()!.n;
      allowed = true;
      guard.reconcileExecution();
      guard.reconcileExecution();
      const resumed = guardDb
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM job WHERE queue='item.start' AND status='pending'",
        )
        .get()!.n;
      observe(
        "a skipped start can be admitted once after reconciliation clears",
        held === 0 && resumed === 1 && getWorkItem(guardDb, "guard-item")?.state === "queued",
        { held, resumed },
      );
    } finally {
      await guard.shutdown();
      guardDb.close();
    }
  } finally {
    await orchestrator.shutdown();
    db.close();
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
