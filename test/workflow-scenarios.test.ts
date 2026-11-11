import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { JOB_KIND } from "../src/core";
import {
  applyLinearCommand,
  applyWorkItemEvent,
  beginImplementRun,
  bindLinearSessionTask,
  claimNextJob,
  completeMergedItem,
  consumeWorkspaceBootstrap,
  deferWorkItem,
  fixRounds,
  getJob,
  getRun,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  markCloseoutAccepted,
  pendingChangeRequests,
  pendingRestartHandoff,
  putWorkspaceUser,
  recordConfirmedRemoteMerge,
  recordItemPullRequest,
  recordLinearInstallation,
  restart,
  runnerCancelPending,
  runnerOccupancy,
  bindWorkItemRepository,
  type Job,
  sqliteDb,
} from "../src/db";
import { acceptGitHubDelivery, worktreeBranch } from "../src/loop";
import { mergeAcceptedWork } from "../src/loop/accepted-work";
import { CONFIRMED_TEARDOWN_RUNNER_VERSION, type RunnerCommand } from "../src/runner-protocol";
import { RUNNER_LEASE_GRACE_MS } from "../src/runner-protocol";
import { createRunnerWork, RunnerTeardownPending, RunnerWorkFencedError } from "../src/runner-work";
import { issueWorkspaceBootstrap, workspaceTokenHash } from "../src/workspace";
import { workspaceDispatch } from "./fake-workspace";
import {
  EXECUTION_QUEUES,
  HOUR,
  JOB_LEASE_MS,
  MINUTE,
  World,
  leaseRunnerWork,
  factsOf,
  unexpectedViolations,
} from "./workflow-world";

function itemJobs(w: World, id: string): Job[] {
  return listJobs(w.db).filter((job) => (job.payload as { itemId?: string }).itemId === id);
}

function liveExecution(w: World, id: string): Job[] {
  return itemJobs(w, id).filter(
    (job) =>
      EXECUTION_QUEUES.includes(job.queue) &&
      (job.status === "pending" || job.status === "running"),
  );
}

describe("combined recovery scenarios", () => {
  test("PAS-959: the same head failing CI twice around a crash reaches the agent and counts both rounds", async () => {
    const w = await new World().seed(["merge_queue"]);
    try {
      const id = "merge_queue";
      const jobKey = `ci-failed:${id}:recheck:head`;
      const first = restart(w.db, getWorkItem(w.db, id)!, {
        reason: "ci",
        body: "first failure",
        jobKey,
        now: w.now,
      })!;
      expect(fixRounds(w.db, id)).toBe(1);
      await workspaceDispatch(w.db, { now: w.now });
      const claimed = claimNextJob(w.db, { now: w.now, queues: [JOB_KIND.resume] });
      expect(claimed?.id).toBe(first);
      beginImplementRun(w.db, id, w.now);

      w.crash();
      w.start();
      expect(await pendingRestartHandoff(sqliteDb(w.db), id)).toEqual({ handoff: "first failure" });
      const resume = liveExecution(w, id).find((job) => job.status === "pending")!;
      expect(resume.payload).toMatchObject({ reason: "process_restart", handoff: "first failure" });

      w.db.run("UPDATE job SET status='done', finished_at=? WHERE id=?", [w.now, resume.id]);
      applyWorkItemEvent(w.db, id, "recovered", { now: w.now });
      applyWorkItemEvent(w.db, id, "turn_ended", { now: w.now });
      applyWorkItemEvent(w.db, id, "closeout_accepted", { now: w.now });
      await markCloseoutAccepted(sqliteDb(w.db), id, "head");

      const second = () =>
        restart(w.db, getWorkItem(w.db, id)!, {
          reason: "ci",
          body: "second failure",
          jobKey,
          now: w.now,
        });
      expect(getJob(w.db, first)?.status).toBe("running");
      expect(second()).toBe(first);
      expect(getJob(w.db, first)).toMatchObject({
        status: "pending",
        payload: { handoff: "second failure", reason: "ci" },
      });
      expect(fixRounds(w.db, id)).toBe(2);

      w.crash();
      w.start();
      w.settle();
      expect(getJob(w.db, first)?.status).toBe("pending");
      expect(await pendingRestartHandoff(sqliteDb(w.db), id)).toEqual({
        handoff: "second failure",
      });
      expect(unexpectedViolations(w.db, w.now)).toEqual([]);
    } finally {
      w.close();
    }
  });

  test("PAS-950: a rejected head stays out of the merge queue through a transient retry and restarts", async () => {
    const w = await new World().seed(["verifying_rejected"]);
    try {
      const id = "verifying_rejected";
      await deferWorkItem(sqliteDb(w.db), getWorkItem(w.db, id)!, {
        retry: 1,
        delayMs: MINUTE,
        handoff: null,
        message: null,
        now: w.now,
      });
      for (let n = 0; n < 2; n++) {
        w.crash();
        w.start();
        expect(await mergeAcceptedWork(sqliteDb(w.db), id, { now: w.now })).toBe(false);
        await markCloseoutAccepted(sqliteDb(w.db), id, "head");
        expect(await mergeAcceptedWork(sqliteDb(w.db), id, { now: w.now })).toBe(false);
        await markCloseoutAccepted(sqliteDb(w.db), id, null as unknown as string);
      }
      w.settle();
      expect(factsOf(w.db, id).state).not.toBe("merge_queue");
      expect(itemJobs(w, id).some((job) => job.queue === JOB_KIND.merge)).toBe(false);
      expect(unexpectedViolations(w.db, w.now)).toEqual([]);
    } finally {
      w.close();
    }
  });

  test("PAS-956: an unknown merge outcome keeps the lane's claim, then stale events cannot revive the merged item", async () => {
    const w = await new World().seed(["merge_inflight"]);
    try {
      const id = "merge_inflight";
      recordItemPullRequest(w.db, { itemId: id, pullNumber: 7, pullUrl: null, openedAt: w.now });
      const stop = {
        type: "stop" as const,
        itemId: id,
        source: "linear" as const,
        requestedAt: w.now,
      };
      expect(applyLinearCommand(w.db, stop)).toEqual({ applied: false, deferred: true });
      for (const entry of ["crash", "stop", "crash"] as const) {
        if (entry === "crash") w.crash();
        else w.stop();
        w.advance(HOUR);
        w.start();
        const facts = factsOf(w.db, id);
        expect([facts.state, facts.mergeCall]).toEqual(["merge_queue", true]);
        expect(restart(w.db, getWorkItem(w.db, id)!, { reason: "ci", body: "x", now: w.now })).toBe(
          null,
        );
        expect(liveExecution(w, id).map((job) => job.queue)).toEqual([JOB_KIND.merge]);
      }
      recordConfirmedRemoteMerge(w.db, {
        itemId: id,
        repositoryOwner: "owner",
        repositoryName: "repo",
        pullNumber: 7,
        pullUrl: null,
        mergeSha: "merged-sha",
        confirmedAt: w.now,
      });
      expect((await completeMergedItem(sqliteDb(w.db), { itemId: id, now: w.now }))?.state).toBe(
        "merged",
      );
      const merged = factsOf(w.db, id);
      expect(merged.mergeCall).toBe(false);

      w.crash();
      w.start();
      expect(applyLinearCommand(w.db, { ...stop, requestedAt: w.now }).applied).toBe(false);
      expect(() =>
        restart(w.db, getWorkItem(w.db, id)!, { reason: "ci", body: "late", now: w.now }),
      ).toThrow("illegal_transition");
      expect(await completeMergedItem(sqliteDb(w.db), { itemId: id, now: w.now })).toBeNull();
      w.settle();
      expect(factsOf(w.db, id)).toMatchObject({ state: "merged", version: merged.version });
      expect(liveExecution(w, id)).toEqual([]);
      expect(unexpectedViolations(w.db, w.now)).toEqual([]);
    } finally {
      w.close();
    }
  });

  test("PAS-942/953: a GitHub review delivered before a crash is applied once, and startup keeps the merge place", async () => {
    const w = await new World().seed(["merge_queue", "merge_active_run"]);
    try {
      const id = "merge_queue";
      recordItemPullRequest(w.db, { itemId: id, pullNumber: 7, pullUrl: null, openedAt: w.now });
      const delivery = {
        deliveryId: "delivery-1",
        event: "pull_request_review",
        payload: JSON.stringify({
          repository: {
            id: 1,
            owner: { login: "owner" },
            name: "repo",
            full_name: "owner/repo",
            default_branch: "main",
          },
          pull_request: {
            number: 7,
            head: { ref: worktreeBranch(getWorkItem(w.db, id)!), sha: "head", repo: { id: 1 } },
            base: { ref: "main" },
          },
          action: "submitted",
          review: { id: 42, state: "changes_requested", body: "Fix it", user: { login: "lead" } },
        }),
      };
      expect(await acceptGitHubDelivery(w.db, delivery, w.now)).toBe(true);
      const reviews = async () =>
        (await pendingChangeRequests(sqliteDb(w.db), id)).map((review) => review.reviewId);
      expect(await reviews()).toEqual([42]);
      const jobs = () => itemJobs(w, id).filter((job) => !EXECUTION_QUEUES.includes(job.queue));
      const effects = jobs();
      const merge = liveExecution(w, id).map((job) => job.id);

      w.crash();
      w.start();
      expect(await acceptGitHubDelivery(w.db, delivery, w.now)).toBe(false);
      w.crash();
      w.advance(1_000);
      w.start();
      expect(await acceptGitHubDelivery(w.db, delivery, w.now)).toBe(false);
      expect(await reviews()).toEqual([42]);
      expect(jobs()).toEqual(effects);
      expect(liveExecution(w, id).map((job) => job.id)).toEqual(merge);
      expect(factsOf(w.db, "merge_active_run").state).toBe("verifying");
      expect(unexpectedViolations(w.db, w.now)).toEqual([]);
    } finally {
      w.close();
    }
  });

  test("PAS-965: lapsed runner leases get one follow-up each before the orphan grace, and restarts add none", async () => {
    const w = await new World().seed(["running_leased", "verifying_leased", "merge_active_run"]);
    try {
      const merging = getWorkItem(w.db, "merge_active_run")!;
      leaseRunnerWork(w.db, merging.currentRunId!, w.now);
      w.advance(MINUTE + RUNNER_LEASE_GRACE_MS);
      w.sweep();
      w.sweep();
      const expected = {
        running_leased: { state: "recovering", liveJobs: [`${JOB_KIND.resume}:pending`] },
        verifying_leased: { state: "verifying", liveJobs: [`${JOB_KIND.reverify}:pending`] },
        merge_active_run: {
          state: "verifying",
          liveJobs: [`${JOB_KIND.merge}:pending`, `${JOB_KIND.reverify}:pending`],
        },
      } as const;
      const check = () => {
        for (const [id, facts] of Object.entries(expected))
          expect(factsOf(w.db, id)).toMatchObject({
            ...facts,
            recoveryAttempts: 0,
            restartHold: false,
            runStatus: "lost",
          });
        expect(unexpectedViolations(w.db, w.now)).toEqual([]);
      };
      check();
      w.crash();
      w.start();
      check();
      w.stop();
      w.start();
      check();
      expect(itemJobs(w, "verifying_leased").some((job) => job.queue === JOB_KIND.resume)).toBe(
        false,
      );
    } finally {
      w.close();
    }
  });

  test("clock discontinuity: a dead job's lease that looks live after the clock steps back never runs a second agent", async () => {
    const w = await new World().seed(["running"]);
    try {
      w.crash();
      w.advance(-HOUR);
      w.start();
      const execution = [JOB_KIND.start, JOB_KIND.resume, JOB_KIND.reverify];
      expect(claimNextJob(w.db, { now: w.now, queues: execution })).toBeNull();
      w.settle();
      expect(claimNextJob(w.db, { now: w.now, queues: execution })).toBeNull();
      w.advance(HOUR + JOB_LEASE_MS);
      const claimed = claimNextJob(w.db, { now: w.now, queues: execution });
      expect(claimed?.queue).toBe(JOB_KIND.resume);
      expect(claimNextJob(w.db, { now: w.now, queues: execution })).toBeNull();
      expect(factsOf(w.db, "running").recoveryAttempts).toBe(1);
    } finally {
      w.close();
    }
  });
});

async function runnerWorld() {
  const w = new World(Date.now());
  const keys = generateKeyPairSync("ed25519");
  const controller = () =>
    createRunnerWork({
      db: w.db,
      keyId: "fixture",
      privateKey: keys.privateKey,
      eventKey: Buffer.alloc(32, 7),
      now: () => w.now,
    });
  const userId = putWorkspaceUser(w.db, {
    id: "me",
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const workspace = consumeWorkspaceBootstrap(w.db, {
    id: "ws",
    organizationId: "org",
    name: "Test",
    userId,
    tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(w.db, "org", w.now)),
    now: w.now,
  });
  w.db.run(
    "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES('box',?,?,'box','active',?,?)",
    [workspace.id, userId, w.now, w.now],
  );
  w.db.run("INSERT INTO workspace_repository VALUES(?,?,?)", [
    workspace.id,
    "fixture/repository",
    "team",
  ]);
  const item = insertQueuedItem(w.db, { id: "item", now: w.now, sessionKey: "session" });
  const { run } = beginImplementRun(w.db, item.id, w.now);
  recordLinearInstallation(w.db, {
    organizationId: "org",
    oauthClientId: "client",
    appUserId: "app",
    sessionId: "session",
    teamId: "team",
    observedAtMs: w.now,
  });
  bindLinearSessionTask(w.db, "session", item.delegationId, { actorId: "owner" });
  const repository = {
    owner: "fixture",
    repo: "repository",
    remoteUrl: "https://github.com/fixture/repository.git",
    baseSha: "a".repeat(40),
  };
  bindWorkItemRepository(w.db, item.id, repository);
  const command: Extract<RunnerCommand, { type: "run" }> = {
    id: "work-1",
    type: "run",
    runnerId: "box",
    workspaceId: workspace.id,
    runId: run.id,
    itemId: item.id,
    generation: 1,
    issuedAt: w.now,
    expiresAt: w.now + 10 * HOUR,
    repository,
    profile: { agent: "claude", model: null },
    prompt: "Implement the issue",
  };
  const host = { runnerVersion: CONFIRMED_TEARDOWN_RUNNER_VERSION.join(".") };
  const work = controller();
  await work.assign(command);
  await work.acknowledge("box", command.id);
  await work.heartbeat(
    "box",
    1,
    host,
    undefined,
    undefined,
    undefined,
    undefined,
    [{ runId: run.id, generation: 1 }],
    undefined,
    [],
  );
  return { w, controller, run, command, host, workspaceId: workspace.id };
}

describe("runner control across Paws restarts", () => {
  test("PAS-943/961: a stop whose teardown is unconfirmed keeps the slot through restarts, sweeps and the cancel receipt", async () => {
    const { w, controller, run, command, host, workspaceId } = await runnerWorld();
    try {
      expect(
        applyLinearCommand(w.db, {
          type: "stop",
          itemId: "item",
          source: "linear",
          requestedAt: w.now,
        }).applied,
      ).toBe(true);
      w.advance(1);
      const cancel = {
        id: "cancel-1",
        type: "cancel" as const,
        runnerId: "box",
        workspaceId,
        runId: run.id,
        generation: 1,
        issuedAt: w.now,
        expiresAt: w.now + MINUTE,
      };
      controller().enqueue(cancel);
      const held = async () => {
        expect(factsOf(w.db, "item")).toMatchObject({ state: "paused", liveJobs: [] });
        expect(runnerOccupancy(w.db, "box", w.now).occupied).toBe(1);
        expect(await runnerCancelPending(sqliteDb(w.db), "box")).toBe(true);
        expect(unexpectedViolations(w.db, w.now)).toEqual([]);
      };
      await held();
      w.crash();
      w.start();
      await held();
      await controller().acknowledge("box", cancel.id);
      w.advance(cancel.expiresAt - w.now + RUNNER_LEASE_GRACE_MS + 1);
      await controller().heartbeat("box", 1, host, undefined, undefined, undefined, undefined, [
        { runId: run.id, generation: 1 },
      ]);
      w.stop();
      w.start();
      w.settle();
      await held();
      expect(() =>
        controller().assign({ ...command, id: "work-2", generation: 2, issuedAt: w.now }),
      ).toThrow(RunnerTeardownPending);

      await controller().heartbeat(
        "box",
        1,
        host,
        undefined,
        undefined,
        undefined,
        undefined,
        [],
        undefined,
        [{ runId: run.id, generation: 1, commandId: command.id }],
      );
      expect(await runnerCancelPending(sqliteDb(w.db), "box")).toBe(false);
      expect(runnerOccupancy(w.db, "box", w.now).occupied).toBe(0);
      w.crash();
      w.start();
      w.settle();
      expect(factsOf(w.db, "item")).toMatchObject({ state: "paused", liveJobs: [] });
      expect(runnerOccupancy(w.db, "box", w.now).occupied).toBe(0);
    } finally {
      w.close();
    }
  });

  test("a runner reconnecting after its lease expired cannot act for the fenced generation", async () => {
    const { w, controller, run } = await runnerWorld();
    try {
      expect((await controller().currentAsync(run.id, 1)).command.id).toBe("work-1");
      w.advance(10 * MINUTE + RUNNER_LEASE_GRACE_MS);
      w.sweep();
      expect(getRun(w.db, run.id)?.status).toBe("lost");
      expect(factsOf(w.db, "item").state).toBe("recovering");
      for (const restartWith of ["crash", "stop"] as const) {
        if (restartWith === "crash") w.crash();
        else w.stop();
        w.start();
        await expect(controller().currentAsync(run.id, 1)).rejects.toThrow(RunnerWorkFencedError);
        await controller().heartbeat("box", 1, {}, undefined, undefined, undefined, undefined, [
          { runId: run.id, generation: 1 },
        ]);
        await expect(controller().currentAsync(run.id, 1)).rejects.toThrow(RunnerWorkFencedError);
      }
      w.settle();
      expect(factsOf(w.db, "item")).toMatchObject({
        state: "recovering",
        restartHold: false,
        recoveryAttempts: 0,
        liveJobs: ["run.resume:pending"],
      });
      expect(liveExecution(w, "item").map((job) => job.status)).toEqual(["pending"]);
      expect(unexpectedViolations(w.db, w.now)).toEqual([]);
    } finally {
      w.close();
    }
  });
});
