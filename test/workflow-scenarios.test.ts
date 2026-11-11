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

async function itemJobs(w: World, id: string): Promise<Job[]> {
  return (await listJobs(sqliteDb(w.db))).filter(
    (job) => (job.payload as { itemId?: string }).itemId === id,
  );
}

async function liveExecution(w: World, id: string): Promise<Job[]> {
  return (await itemJobs(w, id)).filter(
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
      const claimed = await claimNextJob(sqliteDb(w.db), { now: w.now, queues: [JOB_KIND.resume] });
      expect(claimed?.id).toBe(first);
      await beginImplementRun(sqliteDb(w.db), id, w.now);

      w.crash();
      await w.start();
      expect(await pendingRestartHandoff(sqliteDb(w.db), id)).toEqual({ handoff: "first failure" });
      const resume = (await liveExecution(w, id)).find((job) => job.status === "pending")!;
      expect(resume.payload).toMatchObject({ reason: "process_restart", handoff: "first failure" });

      w.db.run("UPDATE job SET status='done', finished_at=? WHERE id=?", [w.now, resume.id]);
      await applyWorkItemEvent(sqliteDb(w.db), id, "recovered", { now: w.now });
      await applyWorkItemEvent(sqliteDb(w.db), id, "turn_ended", { now: w.now });
      await applyWorkItemEvent(sqliteDb(w.db), id, "closeout_accepted", { now: w.now });
      await markCloseoutAccepted(sqliteDb(w.db), id, "head");

      const second = () =>
        restart(w.db, getWorkItem(w.db, id)!, {
          reason: "ci",
          body: "second failure",
          jobKey,
          now: w.now,
        });
      expect((await getJob(sqliteDb(w.db), first))?.status).toBe("running");
      expect(second()).toBe(first);
      expect(await getJob(sqliteDb(w.db), first)).toMatchObject({
        status: "pending",
        payload: { handoff: "second failure", reason: "ci" },
      });
      expect(fixRounds(w.db, id)).toBe(2);

      w.crash();
      await w.start();
      await w.settle();
      expect((await getJob(sqliteDb(w.db), first))?.status).toBe("pending");
      expect(await pendingRestartHandoff(sqliteDb(w.db), id)).toEqual({
        handoff: "second failure",
      });
      expect(await unexpectedViolations(w.db, w.now)).toEqual([]);
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
        await w.start();
        expect(await mergeAcceptedWork(sqliteDb(w.db), id, { now: w.now })).toBe(false);
        await markCloseoutAccepted(sqliteDb(w.db), id, "head");
        expect(await mergeAcceptedWork(sqliteDb(w.db), id, { now: w.now })).toBe(false);
        await markCloseoutAccepted(sqliteDb(w.db), id, null as unknown as string);
      }
      await w.settle();
      expect((await factsOf(w.db, id)).state).not.toBe("merge_queue");
      expect((await itemJobs(w, id)).some((job) => job.queue === JOB_KIND.merge)).toBe(false);
      expect(await unexpectedViolations(w.db, w.now)).toEqual([]);
    } finally {
      w.close();
    }
  });

  test("PAS-956: an unknown merge outcome keeps the lane's claim, then stale events cannot revive the merged item", async () => {
    const w = await new World().seed(["merge_inflight"]);
    try {
      const id = "merge_inflight";
      await recordItemPullRequest(sqliteDb(w.db), {
        itemId: id,
        pullNumber: 7,
        pullUrl: null,
        openedAt: w.now,
      });
      const stop = {
        type: "stop" as const,
        itemId: id,
        source: "linear" as const,
        requestedAt: w.now,
      };
      expect(await applyLinearCommand(sqliteDb(w.db), stop)).toEqual({
        applied: false,
        deferred: true,
      });
      for (const entry of ["crash", "stop", "crash"] as const) {
        if (entry === "crash") w.crash();
        else await w.stop();
        w.advance(HOUR);
        await w.start();
        const facts = await factsOf(w.db, id);
        expect([facts.state, facts.mergeCall]).toEqual(["merge_queue", true]);
        expect(restart(w.db, getWorkItem(w.db, id)!, { reason: "ci", body: "x", now: w.now })).toBe(
          null,
        );
        expect((await liveExecution(w, id)).map((job) => job.queue)).toEqual([JOB_KIND.merge]);
      }
      await recordConfirmedRemoteMerge(sqliteDb(w.db), {
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
      const merged = await factsOf(w.db, id);
      expect(merged.mergeCall).toBe(false);

      w.crash();
      await w.start();
      expect(
        (await applyLinearCommand(sqliteDb(w.db), { ...stop, requestedAt: w.now })).applied,
      ).toBe(false);
      expect(() =>
        restart(w.db, getWorkItem(w.db, id)!, { reason: "ci", body: "late", now: w.now }),
      ).toThrow("illegal_transition");
      expect(await completeMergedItem(sqliteDb(w.db), { itemId: id, now: w.now })).toBeNull();
      await w.settle();
      expect(await factsOf(w.db, id)).toMatchObject({ state: "merged", version: merged.version });
      expect(await liveExecution(w, id)).toEqual([]);
      expect(await unexpectedViolations(w.db, w.now)).toEqual([]);
    } finally {
      w.close();
    }
  });

  test("PAS-942/953: a GitHub review delivered before a crash is applied once, and startup keeps the merge place", async () => {
    const w = await new World().seed(["merge_queue", "merge_active_run"]);
    try {
      const id = "merge_queue";
      await recordItemPullRequest(sqliteDb(w.db), {
        itemId: id,
        pullNumber: 7,
        pullUrl: null,
        openedAt: w.now,
      });
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
      const jobs = async () =>
        (await itemJobs(w, id)).filter((job) => !EXECUTION_QUEUES.includes(job.queue));
      const effects = await jobs();
      const merge = (await liveExecution(w, id)).map((job) => job.id);

      w.crash();
      await w.start();
      expect(await acceptGitHubDelivery(w.db, delivery, w.now)).toBe(false);
      w.crash();
      w.advance(1_000);
      await w.start();
      expect(await acceptGitHubDelivery(w.db, delivery, w.now)).toBe(false);
      expect(await reviews()).toEqual([42]);
      expect(await jobs()).toEqual(effects);
      expect((await liveExecution(w, id)).map((job) => job.id)).toEqual(merge);
      expect((await factsOf(w.db, "merge_active_run")).state).toBe("verifying");
      expect(await unexpectedViolations(w.db, w.now)).toEqual([]);
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
      await w.sweep();
      await w.sweep();
      const expected = {
        running_leased: { state: "recovering", liveJobs: [`${JOB_KIND.resume}:pending`] },
        verifying_leased: { state: "verifying", liveJobs: [`${JOB_KIND.reverify}:pending`] },
        merge_active_run: {
          state: "verifying",
          liveJobs: [`${JOB_KIND.merge}:pending`, `${JOB_KIND.reverify}:pending`],
        },
      } as const;
      const check = async () => {
        for (const [id, facts] of Object.entries(expected))
          expect(await factsOf(w.db, id)).toMatchObject({
            ...facts,
            recoveryAttempts: 0,
            restartHold: false,
            runStatus: "lost",
          });
        expect(await unexpectedViolations(w.db, w.now)).toEqual([]);
      };
      await check();
      w.crash();
      await w.start();
      await check();
      await w.stop();
      await w.start();
      await check();
      expect(
        (await itemJobs(w, "verifying_leased")).some((job) => job.queue === JOB_KIND.resume),
      ).toBe(false);
    } finally {
      w.close();
    }
  });

  test("clock discontinuity: a dead job's lease that looks live after the clock steps back never runs a second agent", async () => {
    const w = await new World().seed(["running"]);
    try {
      w.crash();
      w.advance(-HOUR);
      await w.start();
      const execution = [JOB_KIND.start, JOB_KIND.resume, JOB_KIND.reverify];
      expect(await claimNextJob(sqliteDb(w.db), { now: w.now, queues: execution })).toBeNull();
      await w.settle();
      expect(await claimNextJob(sqliteDb(w.db), { now: w.now, queues: execution })).toBeNull();
      w.advance(HOUR + JOB_LEASE_MS);
      const claimed = await claimNextJob(sqliteDb(w.db), { now: w.now, queues: execution });
      expect(claimed?.queue).toBe(JOB_KIND.resume);
      expect(await claimNextJob(sqliteDb(w.db), { now: w.now, queues: execution })).toBeNull();
      expect((await factsOf(w.db, "running")).recoveryAttempts).toBe(1);
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
  const userId = await putWorkspaceUser(sqliteDb(w.db), {
    id: "me",
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const workspace = await consumeWorkspaceBootstrap(sqliteDb(w.db), {
    id: "ws",
    organizationId: "org",
    name: "Test",
    userId,
    tokenHash: workspaceTokenHash(await issueWorkspaceBootstrap(w.db, "org", w.now)),
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
  const { run } = await beginImplementRun(sqliteDb(w.db), item.id, w.now);
  await recordLinearInstallation(sqliteDb(w.db), {
    organizationId: "org",
    oauthClientId: "client",
    appUserId: "app",
    sessionId: "session",
    teamId: "team",
    observedAtMs: w.now,
  });
  await bindLinearSessionTask(sqliteDb(w.db), "session", item.delegationId, { actorId: "owner" });
  const repository = {
    owner: "fixture",
    repo: "repository",
    remoteUrl: "https://github.com/fixture/repository.git",
    baseSha: "a".repeat(40),
  };
  await bindWorkItemRepository(sqliteDb(w.db), item.id, repository);
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
        (
          await applyLinearCommand(sqliteDb(w.db), {
            type: "stop",
            itemId: "item",
            source: "linear",
            requestedAt: w.now,
          })
        ).applied,
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
        expect(await factsOf(w.db, "item")).toMatchObject({ state: "paused", liveJobs: [] });
        expect((await runnerOccupancy(sqliteDb(w.db), "box", w.now)).occupied).toBe(1);
        expect(await runnerCancelPending(sqliteDb(w.db), "box")).toBe(true);
        expect(await unexpectedViolations(w.db, w.now)).toEqual([]);
      };
      await held();
      w.crash();
      await w.start();
      await held();
      await controller().acknowledge("box", cancel.id);
      w.advance(cancel.expiresAt - w.now + RUNNER_LEASE_GRACE_MS + 1);
      await controller().heartbeat("box", 1, host, undefined, undefined, undefined, undefined, [
        { runId: run.id, generation: 1 },
      ]);
      await w.stop();
      await w.start();
      await w.settle();
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
      expect((await runnerOccupancy(sqliteDb(w.db), "box", w.now)).occupied).toBe(0);
      w.crash();
      await w.start();
      await w.settle();
      expect(await factsOf(w.db, "item")).toMatchObject({ state: "paused", liveJobs: [] });
      expect((await runnerOccupancy(sqliteDb(w.db), "box", w.now)).occupied).toBe(0);
    } finally {
      w.close();
    }
  });

  test("a runner reconnecting after its lease expired cannot act for the fenced generation", async () => {
    const { w, controller, run } = await runnerWorld();
    try {
      expect((await controller().currentAsync(run.id, 1)).command.id).toBe("work-1");
      w.advance(10 * MINUTE + RUNNER_LEASE_GRACE_MS);
      await w.sweep();
      expect((await getRun(sqliteDb(w.db), run.id))?.status).toBe("lost");
      expect((await factsOf(w.db, "item")).state).toBe("recovering");
      for (const restartWith of ["crash", "stop"] as const) {
        if (restartWith === "crash") w.crash();
        else await w.stop();
        await w.start();
        await expect(controller().currentAsync(run.id, 1)).rejects.toThrow(RunnerWorkFencedError);
        await controller().heartbeat("box", 1, {}, undefined, undefined, undefined, undefined, [
          { runId: run.id, generation: 1 },
        ]);
        await expect(controller().currentAsync(run.id, 1)).rejects.toThrow(RunnerWorkFencedError);
      }
      await w.settle();
      expect(await factsOf(w.db, "item")).toMatchObject({
        state: "recovering",
        restartHold: false,
        recoveryAttempts: 0,
        liveJobs: ["run.resume:pending"],
      });
      expect((await liveExecution(w, "item")).map((job) => job.status)).toEqual(["pending"]);
      expect(await unexpectedViolations(w.db, w.now)).toEqual([]);
    } finally {
      w.close();
    }
  });
});
