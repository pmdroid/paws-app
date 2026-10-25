import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeClock, JOB_KIND } from "../../src/core";
import {
  bindLinearSessionTask,
  enqueueJob,
  ensureLinearSession,
  getWorkItem,
  JobLoop,
  migrate,
  openDatabase,
  OutboxDispatcher,
  recordLinearInstallation,
  saveTaskMode,
  insertRun,
  setCurrentRun,
  saveCheckpoint,
  saveRunResult,
  applyLinearCommand,
  applyWorkItemEvent,
  immediate,
} from "../../src/db";
import { closeStoppedPull, createFetchGitHubClient } from "../../src/github";
import { createFakeTracker, createFakeLinearIssueLifecycle } from "../../src/linear";
import { readyItems, syncItemDependencies } from "../../src/intake";
import { Orchestrator, type OrchestratorOptions } from "../../src/loop";
import { workspaceAdmission } from "../fake-workspace";
import { runDir } from "../../src/acp";
import { guardGitHubPublication } from "../../src/loop/publication";

export async function probePublicationStop(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const db = openDatabase(join(root, "paws.sqlite"));
  migrate(db);
  const clock = new FakeClock(1000);
  const calls: { method: string; path: string; body: unknown }[] = [];
  let open = true;
  let patchFails = true;
  let wrongBranch = false;
  let wrongFork = false;
  let duplicates = false;
  let branch = "";
  let onToken: (() => void) | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      calls.push({
        method: request.method,
        path: url.pathname + url.search,
        body: request.method === "PATCH" ? await request.json() : null,
      });
      if (request.method === "GET") {
        const pull = {
          number: 7,
          state: "open",
          head: {
            ref: wrongBranch ? "somebody-else" : branch,
            repo: { full_name: wrongFork ? "foreign/repo" : "owner/repo" },
          },
          base: { ref: "main", repo: { full_name: "owner/repo" } },
        };
        return Response.json(open ? (duplicates ? [pull, pull] : [pull]) : []);
      }
      if (request.method === "PATCH" && patchFails)
        return Response.json({ message: "temporary error" }, { status: 503 });
      if (request.method === "PATCH") {
        open = false;
        return Response.json({ number: 7, state: "closed" });
      }
      throw new Error("Unexpected GitHub operation");
    },
  });
  const github = {
    appId: "unused",
    installationId: "unused",
    privateKeyPem: "unused",
    client: createFetchGitHubClient(fetch, server.url.origin),
    tokenProvider: {
      mode: "token" as const,
      async tokenFor() {
        onToken?.();
        return "synthetic-operation-token";
      },
    },
  };
  const repository = {
    owner: "owner",
    repo: "repo",
    remoteUrl: "https://github.com/owner/repo.git",
  };
  let joined = 0;
  const pendingEpics = new Set<string>();
  let freshness: OrchestratorOptions["publicationReady"];
  const create = (scheduling?: OrchestratorOptions["scheduling"]) => {
    const jobs = new JobLoop(db, clock);
    const orchestrator = new Orchestrator({
      db,
      jobs,
      outbox: new OutboxDispatcher(db, clock),
      clock,
      pawsRoot: root,
      tracker: createFakeTracker(),
      repository,
      github,
      admission: workspaceAdmission(db, {
        authority: (delegationId) => !pendingEpics.has(delegationId),
      }),
      publicationReady: (...args) => freshness?.(...args) ?? true,
      scheduling,
      remoteExecution: {
        agentForSession: () => {
          throw new Error("No helper may launch");
        },
        agentForItem: () => async () => {
          throw new Error("No agent may launch");
        },
        async cancelItem() {
          joined += 1;
        },
      },
    });
    return { orchestrator, jobs };
  };
  let current = create();
  const input = () => ({
    client: github.client,
    owner: "owner",
    repo: "repo",
    branch,
    tokenProvider: github.tokenProvider,
  });
  try {
    db.run(
      "INSERT INTO work_item(id,delegation_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at,session_key) VALUES('item','epic','issue','STOP-1','Stop','merge_queue','paws/stop-1',0,1,'session')",
    );
    ensureLinearSession(db, { sessionId: "session", issueId: "issue", now: clock.now() });
    bindLinearSessionTask(db, "session", "epic");
    branch = getWorkItem(db, "item")!.branchName;
    enqueueJob(db, {
      queue: JOB_KIND.merge,
      payload: { itemId: "item" },
      jobKey: "old-merge",
      now: clock.now(),
    });
    assert.throws(() =>
      immediate(db, () => {
        applyLinearCommand(db, {
          type: "stop",
          source: "linear",
          itemId: "item",
          requestedAt: clock.now(),
        });
        throw new Error("Rollback Stop");
      }),
    );
    observe(
      "canonical Stop and pull cleanup roll back in the same transaction",
      getWorkItem(db, "item")?.state === "merge_queue" &&
        db
          .query<{ n: number }, []>(
            "SELECT COUNT(*) AS n FROM job WHERE queue='github.close_stopped'",
          )
          .get()?.n === 0,
      getWorkItem(db, "item")?.state,
    );
    await current.orchestrator.onLinearEvent({
      dedupeKey: "stop",
      deliveryId: null,
      source: "webhook",
      action: "prompted",
      sessionId: "session",
      issueId: "issue",
      activityId: "stop-activity",
      actorId: "verified-member",
      body: null,
      signal: "stop",
      updatedAtMs: clock.now(),
      payload: "{}",
    });
    observe(
      "Stop cancels canonical merge work and persists PR cleanup before execution",
      getWorkItem(db, "item")?.state === "cancelled" &&
        db.query<{ status: string }, []>("SELECT status FROM job WHERE job_key='old-merge'").get()
          ?.status === "cancelled" &&
        db
          .query<{ status: string }, []>(
            "SELECT status FROM job WHERE queue='github.close_stopped'",
          )
          .get()?.status === "pending" &&
        calls.length === 0,
      { calls, joined },
    );
    await current.orchestrator.shutdown();
    current = create();
    await current.jobs.tick();
    observe(
      "a GitHub outage retains durable stopped PR cleanup without failing the item",
      getWorkItem(db, "item")?.state === "cancelled" &&
        db
          .query<{ status: string }, []>(
            "SELECT status FROM job WHERE queue='github.close_stopped'",
          )
          .get()?.status === "pending" &&
        open,
      { calls, open },
    );
    patchFails = false;
    clock.advance(60000);
    await current.jobs.tick();
    observe(
      "restart retries close only the owned Paws PR after remote joining",
      !open &&
        joined >= 2 &&
        db
          .query<{ status: string }, []>(
            "SELECT status FROM job WHERE queue='github.close_stopped'",
          )
          .get()?.status === "done" &&
        calls
          .filter((call) => call.method === "PATCH")
          .every(
            (call) =>
              call.path === "/repos/owner/repo/pulls/7" &&
              JSON.stringify(call.body) === '{"state":"closed"}',
          ),
      { calls, joined },
    );
    observe(
      "cleanup is idempotent when no open PR remains",
      !(await closeStoppedPull(input())),
      calls.length,
    );
    open = true;
    wrongBranch = true;
    const before = calls.filter((call) => call.method === "PATCH").length;
    await assert.rejects(closeStoppedPull(input()), /does not match/);
    wrongBranch = false;
    wrongFork = true;
    await assert.rejects(closeStoppedPull(input()), /does not match/);
    wrongFork = false;
    duplicates = true;
    await assert.rejects(closeStoppedPull(input()), /identify/);
    duplicates = false;
    observe(
      "foreign branches, fork repositories and ambiguous PRs never mutate GitHub",
      calls.filter((call) => call.method === "PATCH").length === before,
      calls.slice(-3),
    );
    const controller = new AbortController();
    controller.abort();
    const prior = calls.length;
    await assert.rejects(closeStoppedPull({ ...input(), signal: controller.signal }));
    observe(
      "cancelled cleanup never acquires or sends a GitHub request",
      calls.length === prior,
      calls.length,
    );
    let pending = true;
    const guarded = guardGitHubPublication({
      github,
      repository,
      signal: new AbortController().signal,
      onCleanupFailure: () => {},
      isCurrent: () => !pending,
      async assert() {
        if (pending) throw new Error("Refresh is pending");
      },
    });
    await assert.rejects(
      guarded.client.request({
        method: "PATCH",
        path: "/repos/owner/repo/pulls/7",
        token: "synthetic-operation-token",
        body: { state: "closed" },
      }),
    );
    observe(
      "pending authoritative refresh fences mutation at the public publication adapter",
      calls.length === prior,
      calls.length,
    );
    pending = false;
    await guarded.client.request({
      method: "PATCH",
      path: "/repos/owner/repo/pulls/7",
      token: "synthetic-operation-token",
      body: { state: "closed" },
    });
    observe(
      "clearing an unchanged refresh permits the same publication to retry",
      calls.length === prior + 1,
      calls.at(-1),
    );
    db.run(
      "INSERT INTO work_item(id,delegation_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at,session_key) VALUES('pending-item','pending','pending','PEND-1','Pending','merge_queue','paws/pending',0,1,'pending-session')",
    );
    ensureLinearSession(db, { sessionId: "pending-session", issueId: "pending" });
    bindLinearSessionTask(db, "pending-session", "pending");
    pendingEpics.add("pending");
    const pendingJob = enqueueJob(db, {
      queue: JOB_KIND.merge,
      lane: "merge",
      payload: { itemId: "pending-item" },
      jobKey: "pending-refresh-merge",
      now: clock.now(),
    });
    const beforePending = calls.length;
    await current.jobs.tick();
    await current.jobs.tick();
    const successor = db
      .query<{ n: number; runAt: number }, [string]>(
        "SELECT COUNT(*) AS n,MIN(run_at) AS runAt FROM job WHERE job_key=? AND status='pending'",
      )
      .get(`merge-reconciliation:${pendingJob}`);
    observe(
      "production merge waits durably without exhausting retry attempts or asking a person",
      successor?.n === 1 &&
        successor.runAt === clock.now() + 30000 &&
        getWorkItem(db, "pending-item")?.state === "merge_queue" &&
        calls.length === beforePending,
      { successor, calls: calls.length },
    );
    current.orchestrator.applyDelegationChanges({
      delegationId: "pending",
      sessionId: "pending-session",
      addedItemIds: [],
      removedItemIds: [],
      specChangedItemIds: [],
      canceledItemIds: [],
      parentCanceled: true,
    });
    for (const [position, id] of ["a", "b", "free"].entries()) {
      db.run(
        "INSERT INTO work_item(id,delegation_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at,session_key,brief) VALUES(?,'cycle',?,?,?,'queued',?, ?,1,'cycle-session',?)",
        [
          `cycle-${id}`,
          id,
          id,
          id,
          `paws/${id}`,
          position,
          JSON.stringify({
            issue: {
              source: "linear",
              issueId: id,
              identifier: id,
              title: id,
              description: null,
              acceptanceCriteria: null,
            },
            epic: {
              source: "linear",
              issueId: "cycle-parent",
              identifier: "CYC-1",
              title: "Cycle",
              description: null,
              acceptanceCriteria: null,
            },
          }),
        ],
      );
      saveTaskMode(db, `cycle-${id}`, "code");
    }
    db.run(
      "INSERT INTO workspace(id,linear_organization_id,name,created_at) VALUES('cycle-workspace','cycle-org','Cycle workspace',1)",
    );
    ensureLinearSession(db, {
      sessionId: "cycle-session",
      issueId: "cycle-parent",
      organizationId: "cycle-org",
      appUserId: "cycle-app",
      creatorId: "cycle-human",
    });
    bindLinearSessionTask(db, "cycle-session", "cycle");
    recordLinearInstallation(db, {
      sessionId: "cycle-session",
      organizationId: "cycle-org",
      oauthClientId: "cycle-client",
      appUserId: "cycle-app",
      teamId: "cycle-team",
      observedAtMs: clock.now(),
    });
    const cycleTracker = createFakeTracker();
    cycleTracker.deps.set("cycle-parent", [
      { blockerLinearIssueId: "a", blockedLinearIssueId: "b" },
      { blockerLinearIssueId: "b", blockedLinearIssueId: "a" },
    ]);
    const ownership = {
      teamId: "cycle-team",
      stateType: "started",
      assigneeId: "cycle-human",
      delegateId: "cycle-app",
    };
    const lifecycle = createFakeLinearIssueLifecycle({ id: "a", ...ownership });
    lifecycle.issues.set("b", { id: "b", ...ownership });
    for (const itemId of ["cycle-a", "cycle-b", "cycle-free"])
      await syncItemDependencies(db, {
        itemId,
        workspaceId: "cycle-workspace",
        expectedGeneration: readyItems(db, { itemId, workspaceId: "cycle-workspace" }).generation,
        tracker: cycleTracker,
        lifecycle,
      });
    current.orchestrator.reconcileExecution();
    current.orchestrator.reconcileExecution();
    const cycleQuestion = db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM outbox WHERE idempotency_key LIKE 'dependency-cycle:cycle:%'",
      )
      .get()?.n;
    const openQuestions = db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM question WHERE session_id='cycle-session' AND status='open' AND cancelled_at IS NULL",
      )
      .get()?.n;
    const freeJob = db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM job WHERE queue='item.start' AND json_extract(payload,'$.itemId')='cycle-free' AND status='pending'",
      )
      .get()?.n;
    observe(
      "authoritative cycles notice once while unaffected queued work remains dispatchable",
      cycleQuestion === 1 && openQuestions === 0 && freeJob === 1,
      { cycleQuestion, openQuestions, freeJob },
    );
    current.orchestrator.reconcileExecution();
    observe(
      "a cycle notice stays one-shot and does not open a stall question",
      db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM outbox WHERE idempotency_key LIKE 'dependency-cycle:cycle:%'",
        )
        .get()?.n === 1 &&
        db
          .query<{ n: number }, []>(
            "SELECT COUNT(*) AS n FROM question WHERE session_id='cycle-session' AND status='open' AND cancelled_at IS NULL",
          )
          .get()?.n === 0,
      db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM question WHERE session_id='cycle-session'",
        )
        .get(),
    );
    db.run(
      `CREATE TABLE IF NOT EXISTS work_item_specification(item_id TEXT PRIMARY KEY REFERENCES work_item(id),hash TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),present INTEGER NOT NULL CHECK(present IN(0,1))) STRICT`,
    );
    for (const [delegationId, oldState, newState] of [
      ["restored", "cancelled", "queued"],
      ["all-removed", "cancelled", null],
      ["delivered-history", "merged", "cancelled"],
    ] as const) {
      db.run(
        "INSERT INTO work_item(id,delegation_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at) VALUES(?,?,?,?,?,?,?,0,1)",
        [
          `${delegationId}-old`,
          delegationId,
          `${delegationId}-issue`,
          delegationId,
          delegationId,
          oldState,
          `paws/${delegationId}-old`,
        ],
      );
      db.run(
        "INSERT INTO work_item_specification(item_id,hash,revision,present) VALUES(?,'old',1,0)",
        [`${delegationId}-old`],
      );
      if (newState) {
        db.run(
          "INSERT INTO work_item(id,delegation_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at) VALUES(?,?,?,?,?,?,?,0,1)",
          [
            `${delegationId}-new`,
            delegationId,
            `${delegationId}-issue`,
            delegationId,
            delegationId,
            newState,
            `paws/${delegationId}-new`,
          ],
        );
        db.run(
          "INSERT INTO work_item_specification(item_id,hash,revision,present) VALUES(?,'new',1,1)",
          [`${delegationId}-new`],
        );
      }
    }
    db.run("UPDATE work_item SET state='cancelled' WHERE id='cycle-free'");
    pendingEpics.add("all-removed");
    current.orchestrator.reconcileExecution();
    const restored = db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM job WHERE json_extract(payload,'$.itemId')='restored-new' AND status='pending'",
      )
      .get()?.n;
    observe(
      "restored child dispatch ignores archived history while refresh holds empty epics",
      restored === 1 &&
        getWorkItem(db, "all-removed-old")?.state === "cancelled" &&
        getWorkItem(db, "restored-old")?.state === "cancelled",
      { restored },
    );
    pendingEpics.delete("all-removed");
    current.orchestrator.reconcileExecution();
    const outcomes = [
      getWorkItem(db, "all-removed-old")?.state,
      getWorkItem(db, "delivered-history-old")?.state,
      getWorkItem(db, "delivered-history-new")?.state,
    ];
    observe(
      "all removed work stays cancelled and delivered history stays terminal",
      JSON.stringify(outcomes) === JSON.stringify(["cancelled", "merged", "cancelled"]),
      outcomes,
    );
    db.run(
      "INSERT INTO work_item(id,delegation_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at,session_key) VALUES('owned-refresh-item','owned-refresh','owned-refresh','OWN-1','Owned','merge_queue','paws/owned-refresh',0,1,'owned-refresh-session')",
    );
    ensureLinearSession(db, { sessionId: "owned-refresh-session", issueId: "owned-refresh" });
    bindLinearSessionTask(db, "owned-refresh-session", "owned-refresh");
    const ownedRun = insertRun(db, {
      itemId: "owned-refresh-item",
      kind: "implement",
      agent: "codex",
      status: "ended",
      freshSession: true,
      now: clock.now(),
    });
    setCurrentRun(db, "owned-refresh-item", ownedRun.id);
    saveCheckpoint(db, "owned-refresh-item", {
      phase: "merge_queue",
      wipCommit: "a".repeat(40),
      baseSha: "b".repeat(40),
    });
    mkdirSync(runDir(root, ownedRun.id), { recursive: true });
    writeFileSync(
      join(runDir(root, ownedRun.id), "agent-profile.json"),
      JSON.stringify({
        candidate: { session: "producer", model: "scripted", provider: "fake" },
        profiles: { implementer: { agent: "codex" }, reviewer: { agent: "codex" } },
      }),
    );
    freshness = (itemId) => !pendingEpics.has(getWorkItem(db, itemId)!.delegationId);
    onToken = () => {
      onToken = undefined;
      pendingEpics.add("owned-refresh");
    };
    const tokenRace = enqueueJob(db, {
      queue: JOB_KIND.merge,
      payload: { itemId: "owned-refresh-item" },
      priority: -100,
      now: clock.now(),
    });
    await current.jobs.tick();
    observe(
      "a refresh arriving during token acquisition defers without consuming job retries",
      db.query<{ status: string }, [number]>("SELECT status FROM job WHERE id=?").get(tokenRace)
        ?.status === "done" &&
        db
          .query("SELECT 1 FROM job WHERE job_key=? AND status='pending'")
          .get(`merge-reconciliation:${tokenRace}`) !== null,
      db
        .query("SELECT id,status,attempts FROM job WHERE id=? OR job_key=?")
        .all(tokenRace, `merge-reconciliation:${tokenRace}`),
    );
    pendingEpics.delete("owned-refresh");
    freshness = () => {
      applyWorkItemEvent(db, "owned-refresh-item", "reverify_requested");
      return false;
    };
    const verifyingRace = enqueueJob(db, {
      queue: JOB_KIND.merge,
      payload: { itemId: "owned-refresh-item" },
      priority: -100,
      now: clock.now(),
    });
    await current.jobs.tick();
    observe(
      "pending reconciliation retains required verification rather than skipping its successor",
      getWorkItem(db, "owned-refresh-item")?.state === "verifying" &&
        db
          .query("SELECT 1 FROM job WHERE job_key=? AND queue=? AND status='pending'")
          .get(`merge-reconciliation:${verifyingRace}`, JOB_KIND.reverify) !== null,
      db
        .query("SELECT queue,status FROM job WHERE job_key=?")
        .get(`merge-reconciliation:${verifyingRace}`),
    );
    applyWorkItemEvent(db, "owned-refresh-item", "closeout_accepted");
    let shared: Promise<void> | undefined;
    let callerAborted = false;
    let joinedRefresh = false;
    const beforeOwned = calls.length;
    freshness = async (itemId, phase, signal, candidate) => {
      assert.equal(itemId, "owned-refresh-item");
      assert.equal(phase, "publish");
      assert.equal(candidate?.sha, "a".repeat(40));
      assert(signal);
      const waiter = new Promise<never>((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            callerAborted = true;
            reject(signal.reason);
          },
          { once: true },
        ),
      );
      shared = Promise.resolve().then(async () => {
        const change = {
          delegationId: "owned-refresh",
          sessionId: "owned-refresh-session",
          addedItemIds: [],
          removedItemIds: [],
          canceledItemIds: [],
          specChangedItemIds: ["owned-refresh-item"],
          parentCanceled: false,
        };
        current.orchestrator.applyDelegationChanges(change);
        await current.orchestrator.finishDelegationChanges(change);
        joinedRefresh = true;
      });
      return waiter;
    };
    enqueueJob(db, {
      queue: JOB_KIND.merge,
      lane: "merge",
      priority: 0,
      payload: { itemId: "owned-refresh-item" },
      jobKey: "owned-refresh-merge",
      now: clock.now(),
    });
    await current.jobs.tick();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        shared,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Owned refresh did not join")), 1000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    observe(
      "criteria invalidation aborts an owned publication freshness waiter before joining its job",
      callerAborted &&
        joinedRefresh &&
        getWorkItem(db, "owned-refresh-item")?.state === "queued" &&
        calls.length === beforeOwned,
      {
        callerAborted,
        joinedRefresh,
        item: getWorkItem(db, "owned-refresh-item")?.state,
        calls: calls.length,
      },
    );
    await current.orchestrator.shutdown();
    current = create(() => ({}));
    for (const [delegationId, retiredState] of [
      ["handoff-history", "merged"],
      ["cancelled-history", "cancelled"],
    ] as const) {
      for (const [suffix, state, present] of [
        ["old", retiredState, 0],
        ["new", "merged", 1],
        ["consumer", "queued", 1],
      ] as const) {
        const itemId = `${delegationId}-${suffix}`;
        const issueId = suffix === "consumer" ? itemId : `${delegationId}-issue`;
        db.run(
          "INSERT INTO work_item(id,delegation_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at) VALUES(?,?,?,?,?,?,?,0,1)",
          [itemId, delegationId, issueId, itemId, itemId, state, `paws/${itemId}`],
        );
        db.run(
          "INSERT INTO work_item_specification(item_id,hash,revision,present) VALUES(?,'version',1,?)",
          [itemId, present],
        );
        if (state === "merged") {
          const producer = insertRun(db, {
            itemId,
            kind: "implement",
            agent: "codex",
            status: "ended",
            freshSession: true,
            now: clock.now(),
          });
          saveRunResult(
            db,
            producer.id,
            suffix === "old" ? "Obsolete schema" : "Current schema",
            clock.now(),
          );
          setCurrentRun(db, itemId, producer.id);
        }
      }
      db.run(
        "INSERT INTO task_block(blocker_linear_issue_id,blocked_linear_issue_id) VALUES(?,?)",
        [`${delegationId}-issue`, `${delegationId}-consumer`],
      );
    }
    current.orchestrator.reconcileExecution();
    const handoff = current.orchestrator.dependencyHandoff("handoff-history-consumer");
    const readyIds = db
      .query<{ id: string }, []>("SELECT item_id AS id FROM scheduler_admission")
      .all()
      .map((row) => row.id);
    observe(
      "active dependency handoffs and readiness ignore archived producers sharing the Linear issue",
      handoff?.includes("Current schema") === true &&
        !handoff.includes("Obsolete schema") &&
        readyIds.includes("cancelled-history-consumer"),
      { handoff, readyIds },
    );
  } finally {
    await current.orchestrator.shutdown();
    server.stop(true);
    db.close();
  }
}

if (import.meta.main) {
  const root = process.argv[2];
  if (!root) throw new Error("Provide a disposable proof directory");
  const observations: unknown[] = [];
  await probePublicationStop(root, (name, passed, observed) => {
    observations.push({ name, passed, observed });
    writeFileSync(join(root, "observations.json"), JSON.stringify(observations, null, 2));
    assert(passed, name);
  });
  console.log(JSON.stringify({ root, observations: observations.length }));
}
