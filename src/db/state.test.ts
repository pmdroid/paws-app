import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandBus, FakeClock, JOB_KIND, type Checkpoint } from "../core";
import {
  accrueAwake,
  applyLinearCommand,
  applyDecision,
  applyWorkItemEvent,
  beginImplementRun,
  beginMergeCall,
  bindWorkItemRepository,
  cancelOpenJobs,
  claimNextJob,
  completeJob,
  deferWorkItem,
  enqueueJob,
  enqueueJobOnce,
  enterMergeQueue,
  getItemPullRequest,
  getJob,
  getRun,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  listOutbox,
  markRun,
  migrate,
  openDatabase,
  prepareShutdown,
  recordItemBranchState,
  recordItemPullRequest,
  recoverOnStartup,
  saveCheckpoint,
  saveRunResult,
  saveTaskMode,
  submitCommand,
  syncClock,
  takeOverItem,
  TransitionRejectedError,
  sqliteDb,
} from "./index";

function harness() {
  const clock = new FakeClock(20_000);
  const db = openDatabase(":memory:");
  migrate(db);
  return { clock, db };
}

const checkpoint: Checkpoint = { phase: "running", wipCommit: "wip", turn: 2, baseSha: "base" };

describe("restart recovery", () => {
  test("the first start resumes from the checkpoint and the next one asks in Linear", async () => {
    const { db, clock } = harness();
    const item = insertQueuedItem(db, { id: "eng-1", sessionKey: "ses", now: clock.now() });
    const { run } = await beginImplementRun(sqliteDb(db), item.id, clock.now(), checkpoint);

    expect(await recoverOnStartup(sqliteDb(db), clock.now())).toEqual([
      { type: "resume", freshSession: true, checkpoint },
    ]);
    expect(getWorkItem(db, item.id)).toMatchObject({ state: "recovering", recoveryAttempts: 1 });
    expect(getRun(db, run.id)?.status).toBe("active");
    expect(await listOutbox(sqliteDb(db))).toHaveLength(0);
    const resume = (await listJobs(sqliteDb(db))).find((job) => job.queue === "run.resume");
    expect(resume?.status).toBe("pending");
    expect(resume?.payload).toMatchObject({ freshSession: true, runId: run.id, checkpoint });
    expect(resume?.payload).not.toHaveProperty("handoff");

    expect(await recoverOnStartup(sqliteDb(db), clock.now())).toEqual([{ type: "ask_restart" }]);
    expect(getWorkItem(db, item.id)).toMatchObject({ state: "recovering", recoveryAttempts: 1 });
    expect(getRun(db, run.id)?.status).toBe("ended");
    expect((await listJobs(sqliteDb(db))).find((job) => job.queue === "run.resume")?.status).toBe(
      "cancelled",
    );
    const request = (await listJobs(sqliteDb(db))).find((job) => job.queue === "item.ask");
    expect(request?.payload).toMatchObject({
      itemId: item.id,
      kind: "agent",
      options: ["Start again"],
    });
    expect(await listOutbox(sqliteDb(db))).toHaveLength(0);
  });

  test("a second restart without a Linear session fails the item", async () => {
    const { db, clock } = harness();
    const item = insertQueuedItem(db, { now: clock.now() });
    db.run("UPDATE work_item SET session_key = NULL WHERE id = ?", [item.id]);
    await beginImplementRun(sqliteDb(db), item.id, clock.now(), checkpoint);
    await recoverOnStartup(sqliteDb(db), clock.now());
    expect(await recoverOnStartup(sqliteDb(db), clock.now())).toEqual([{ type: "ask_restart" }]);
    expect(getWorkItem(db, item.id)?.state).toBe("failed");
    expect((await listOutbox(sqliteDb(db)))[0]?.payload).toMatchObject({
      kind: "error",
      body: "Stopped after a restart because this run was already resumed once.",
    });
  });

  test("a code task with no checkpoint starts again from its branch", async () => {
    const { db, clock } = harness();
    const item = insertQueuedItem(db, {
      id: "eng-2",
      sessionKey: "ses",
      branchName: "paws/eng-2",
      now: clock.now(),
    });
    await saveTaskMode(sqliteDb(db), item.id, "code", 0);
    const { run } = await beginImplementRun(sqliteDb(db), item.id, clock.now());
    expect(await recoverOnStartup(sqliteDb(db), clock.now())).toEqual([
      { type: "resume", freshSession: true, checkpoint: null },
    ]);
    expect(getWorkItem(db, item.id)).toMatchObject({ state: "recovering", recoveryAttempts: 1 });
    const resume = (await listJobs(sqliteDb(db))).find((job) => job.queue === "run.resume");
    expect(resume?.status).toBe("pending");
    expect(resume?.payload).toMatchObject({
      itemId: item.id,
      runId: run.id,
      freshSession: true,
      checkpoint: null,
      reason: "process_restart",
    });
    expect(resume?.payload).toMatchObject({
      handoff: expect.stringContaining("from the branch paws/eng-2"),
    });
    expect(await listOutbox(sqliteDb(db))).toHaveLength(0);
  });

  test("a restart long after the earlier resume resumes the task again", async () => {
    const { db, clock } = harness();
    const item = insertQueuedItem(db, { id: "eng-later", sessionKey: "ses", now: clock.now() });
    await beginImplementRun(sqliteDb(db), item.id, clock.now(), checkpoint);
    await recoverOnStartup(sqliteDb(db), clock.now());
    clock.advance(45 * 60_000);

    expect(await recoverOnStartup(sqliteDb(db), clock.now())).toEqual([
      { type: "resume", freshSession: true, checkpoint },
    ]);
    expect(getWorkItem(db, item.id)).toMatchObject({ state: "recovering", recoveryAttempts: 1 });
    expect(await listOutbox(sqliteDb(db))).toHaveLength(0);
    expect(await recoverOnStartup(sqliteDb(db), clock.now())).toEqual([{ type: "ask_restart" }]);
  });

  for (const queue of [JOB_KIND.start, JOB_KIND.resume, JOB_KIND.reverify]) {
    for (const graceful of [true, false]) {
      test(`a parked ${queue} survives repeated ${graceful ? "graceful" : "crash"} restarts without recovery`, async () => {
        const { db, clock } = harness();
        const item = insertQueuedItem(db, { now: clock.now() });
        const { run } = await beginImplementRun(sqliteDb(db), item.id, clock.now(), checkpoint);
        if (queue === JOB_KIND.reverify)
          await applyWorkItemEvent(sqliteDb(db), item.id, "turn_ended");
        if (queue === JOB_KIND.resume)
          await applyWorkItemEvent(sqliteDb(db), item.id, "lease_expired");
        db.run("UPDATE work_item SET recovery_attempts=1 WHERE id=?", [item.id]);
        const state = getWorkItem(db, item.id)!.state;
        const id = await enqueueJob(sqliteDb(db), {
          queue,
          payload: {
            itemId: item.id,
            capacityWait: { since: clock.now(), attempt: 0, runnerIds: ["busy"] },
          },
          now: clock.now(),
        });
        await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now());
        for (let restart = 0; restart < 3; restart++) {
          if (graceful) await prepareShutdown(sqliteDb(db), clock.now());
          expect(await recoverOnStartup(sqliteDb(db), clock.now())).toEqual([]);
          clock.advance(20 * 60_000);
          await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now());
        }
        expect(getWorkItem(db, item.id)).toMatchObject({
          state,
          currentRunId: run.id,
          recoveryAttempts: 1,
          awakeMs: 0,
          waitingMs: 60 * 60_000,
        });
        expect(getRun(db, run.id)?.status).toBe("active");
        expect(
          (await listJobs(sqliteDb(db))).filter((job) => job.status === "pending"),
        ).toMatchObject([{ id }]);
        expect((await claimNextJob(sqliteDb(db), { now: clock.now(), queues: [queue] }))?.id).toBe(
          id,
        );
        expect(await listOutbox(sqliteDb(db))).toEqual([]);
        db.close();
      });
    }
  }

  test("restarts keep a task running while its runner still holds the work", async () => {
    const { db, clock } = harness();
    const item = insertQueuedItem(db, { now: clock.now() });
    const { run } = await beginImplementRun(sqliteDb(db), item.id, clock.now(), checkpoint);
    db.run("PRAGMA foreign_keys=OFF");
    db.run(
      "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until) VALUES(?,?,?,?,?,?,?)",
      [run.id, "runner", "workspace", 1, 0, "command", clock.now() + 60_000],
    );
    for (let restart = 0; restart < 3; restart++) {
      await prepareShutdown(sqliteDb(db), clock.now());
      await recoverOnStartup(sqliteDb(db), clock.now());
    }
    expect({
      item: getWorkItem(db, item.id),
      run: getRun(db, run.id)?.status,
    }).toMatchObject({ item: { state: "running", recoveryAttempts: 0 }, run: "active" });
  });

  test("each restart that reattaches a running task queues a job to follow it", async () => {
    const { db, clock } = harness();
    const item = insertQueuedItem(db, { now: clock.now() });
    const { run } = await beginImplementRun(sqliteDb(db), item.id, clock.now(), checkpoint);
    db.run("PRAGMA foreign_keys=OFF");
    db.run(
      "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until) VALUES(?,?,?,?,?,?,?)",
      [run.id, "runner", "workspace", 1, 0, "command", clock.now() + 3_600_000],
    );
    for (let restart = 0; restart < 2; restart++) {
      await prepareShutdown(sqliteDb(db), clock.now());
      await recoverOnStartup(sqliteDb(db), clock.now());
      expect(
        (await listJobs(sqliteDb(db))).filter(
          (job) => job.queue === "run.resume" && job.status === "pending",
        ),
      ).toHaveLength(1);
      db.run("UPDATE job SET status='done', finished_at=? WHERE queue='run.resume'", [clock.now()]);
      clock.advance(20 * 60_000);
    }
  });

  test("a second restart while the reattach follower is pending queues no other one", async () => {
    const { db, clock } = harness();
    const item = insertQueuedItem(db, { now: clock.now() });
    const { run } = await beginImplementRun(sqliteDb(db), item.id, clock.now(), checkpoint);
    db.run("PRAGMA foreign_keys=OFF");
    db.run(
      "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until) VALUES(?,?,?,?,?,?,?)",
      [run.id, "runner", "workspace", 1, 0, "command", clock.now() + 3_600_000],
    );
    await recoverOnStartup(sqliteDb(db), clock.now());
    clock.advance(60_000);
    await recoverOnStartup(sqliteDb(db), clock.now());
    expect(
      (await listJobs(sqliteDb(db))).filter(
        (job) => job.queue === "run.resume" && job.status === "pending",
      ),
    ).toHaveLength(1);
  });

  describe("a pending transient retry", () => {
    async function deferred() {
      const { db, clock } = harness();
      const item = insertQueuedItem(db, { sessionKey: "ses", now: clock.now() });
      const { item: running } = await beginImplementRun(
        sqliteDb(db),
        item.id,
        clock.now(),
        checkpoint,
      );
      await deferWorkItem(sqliteDb(db), running, {
        retry: 4,
        delayMs: 600_000,
        handoff: "keep going",
        message: "Retrying.",
        now: clock.now(),
      });
      return { db, clock, item, runAt: clock.now() + 600_000 };
    }
    const pendingResumes = async (db: ReturnType<typeof harness>["db"]) =>
      (await listJobs(sqliteDb(db))).filter(
        (job) => job.queue === JOB_KIND.resume && job.status === "pending",
      );

    test("survives repeated restarts with its deadline, retry count and handoff", async () => {
      const { db, clock, item, runAt } = await deferred();
      for (let restart = 0; restart < 3; restart++) {
        clock.advance(1_000);
        await prepareShutdown(sqliteDb(db), clock.now());
        await recoverOnStartup(sqliteDb(db), clock.now());
      }
      expect(await pendingResumes(db)).toMatchObject([
        { runAt, payload: { reason: "transient_failure", retry: 4, handoff: "keep going" } },
      ]);
      expect(getWorkItem(db, item.id)).toMatchObject({ state: "recovering", recoveryAttempts: 0 });
      expect(await claimNextJob(sqliteDb(db), { now: clock.now() })).toBeNull();
    });

    test("runs once with its saved retry count when due", async () => {
      const { db, clock, runAt } = await deferred();
      clock.advance(700_000);
      await recoverOnStartup(sqliteDb(db), clock.now());
      const claimed = await claimNextJob(sqliteDb(db), { now: clock.now() });
      expect(claimed).toMatchObject({ runAt, payload: { retry: 4, handoff: "keep going" } });
      await completeJob(sqliteDb(db), claimed!, clock.now());
      expect(await claimNextJob(sqliteDb(db), { now: clock.now() })).toBeNull();
    });

    test("does not run after the item is cancelled", async () => {
      const { db, clock, item } = await deferred();
      await recoverOnStartup(sqliteDb(db), clock.now());
      await cancelOpenJobs(sqliteDb(db), { itemId: item.id, reason: "stop", now: clock.now() });
      clock.advance(700_000);
      expect(await claimNextJob(sqliteDb(db), { now: clock.now() })).toBeNull();
    });
  });

  test("a verifying task whose runner holds Closeout work stays verifying and re-verifies", async () => {
    const { db, clock } = harness();
    const item = insertQueuedItem(db, { now: clock.now() });
    const { run } = await beginImplementRun(sqliteDb(db), item.id, clock.now(), checkpoint);
    await applyWorkItemEvent(sqliteDb(db), item.id, "turn_ended");
    db.run("PRAGMA foreign_keys=OFF");
    db.run(
      "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until) VALUES(?,?,?,?,?,?,?)",
      [run.id, "runner", "workspace", 1, 0, "command", clock.now() + 60_000],
    );
    await prepareShutdown(sqliteDb(db), clock.now());
    expect(await recoverOnStartup(sqliteDb(db), clock.now())).toEqual([{ type: "reverify" }]);
    expect(getWorkItem(db, item.id)).toMatchObject({ state: "verifying", recoveryAttempts: 0 });
    expect(
      (await listJobs(sqliteDb(db))).filter(
        (job) => job.queue === JOB_KIND.reverify && job.status === "pending",
      ),
    ).toHaveLength(1);
  });

  test("shutdown leaves the run recoverable and the next start can resume it once", async () => {
    const { db, clock } = harness();
    const item = insertQueuedItem(db, { sessionKey: "ses", now: clock.now() });
    const { run } = await beginImplementRun(sqliteDb(db), item.id, clock.now(), checkpoint);
    await prepareShutdown(sqliteDb(db), clock.now());
    expect(getWorkItem(db, item.id)).toMatchObject({ state: "recovering", recoveryAttempts: 0 });
    expect(getRun(db, run.id)?.status).toBe("lost");

    await recoverOnStartup(sqliteDb(db), clock.now());
    expect(getWorkItem(db, item.id)).toMatchObject({ state: "recovering", recoveryAttempts: 1 });
    expect(getRun(db, run.id)?.status).toBe("active");

    await prepareShutdown(sqliteDb(db), clock.now());
    expect(getWorkItem(db, item.id)?.recoveryAttempts).toBe(1);
    await recoverOnStartup(sqliteDb(db), clock.now());
    expect(
      (await listJobs(sqliteDb(db))).some(
        (job) => job.queue === "item.ask" && job.status === "pending",
      ),
    ).toBe(true);
  });

  test("a task waiting in the merge queue keeps its state and its merge job across a restart", async () => {
    const { db, clock } = harness();
    const item = insertQueuedItem(db, {
      id: "eng-1",
      branchName: "paws/eng-1",
      now: clock.now(),
    });
    const { run } = await beginImplementRun(sqliteDb(db), item.id, clock.now(), checkpoint);
    await enterMergeQueue(sqliteDb(db), item.id, checkpoint);
    await markRun(sqliteDb(db), run.id, "ended", clock.now());
    const merge = await enqueueJob(sqliteDb(db), {
      queue: "github.merge",
      payload: { itemId: item.id },
      now: clock.now(),
    });

    await prepareShutdown(sqliteDb(db), clock.now());
    expect(await recoverOnStartup(sqliteDb(db), clock.now())).toEqual([
      { type: "keep_place", mergeCallInFlight: false },
    ]);
    expect(getWorkItem(db, item.id)).toMatchObject({
      state: "merge_queue",
      checkpoint: { phase: "merge_queue" },
    });
    expect(getRun(db, run.id)?.status).toBe("ended");
    expect((await getJob(sqliteDb(db), merge))?.status).toBe("pending");
    expect((await listJobs(sqliteDb(db))).map((job) => job.queue)).toEqual(["github.merge"]);
    expect(await listOutbox(sqliteDb(db))).toHaveLength(0);
  });

  for (const order of ["keep-first", "reverify-first"] as const) {
    for (const sameRepository of [true, false]) {
      for (const status of ["pending", "running"] as const) {
        for (const inFlight of [false, true]) {
          test(`mixed startup ${order}, same repo=${sameRepository}, ${status}, in flight=${inFlight} preserves unrelated merge work`, async () => {
            const { db, clock } = harness();
            const ids = order === "keep-first" ? ["keep", "reverify"] : ["reverify", "keep"];
            for (const id of ids) {
              insertQueuedItem(db, { id, now: clock.now() });
              await bindWorkItemRepository(sqliteDb(db), id, {
                owner: "owner",
                repo: sameRepository ? "shared" : id,
                remoteUrl: `https://github.com/owner/${sameRepository ? "shared" : id}.git`,
              });
              const { run } = await beginImplementRun(sqliteDb(db), id, clock.now(), checkpoint);
              await enterMergeQueue(sqliteDb(db), id, checkpoint);
              if (id === "keep") await markRun(sqliteDb(db), run.id, "ended", clock.now());
              clock.advance(1);
            }
            const mergeId = await enqueueJob(sqliteDb(db), {
              queue: JOB_KIND.merge,
              payload: {
                itemId: "keep",
                head: "abc",
                summary: "Accepted",
                mergeCallInFlight: inFlight,
              },
              runAt: status === "pending" && !inFlight ? clock.now() + 60_000 : clock.now(),
              now: clock.now(),
            });
            if (status === "running") {
              expect(
                (
                  await claimNextJob(sqliteDb(db), {
                    queues: [JOB_KIND.merge],
                    workerId: "merger",
                    now: clock.now(),
                  })
                )?.id,
              ).toBe(mergeId);
            }
            if (inFlight) beginMergeCall(db, "keep", "abc", clock.now());
            const savedJob = await getJob(sqliteDb(db), mergeId);
            const savedItem = getWorkItem(db, "keep");
            const savedMarker = db.query("SELECT * FROM merge_call WHERE item_id = ?").get("keep");
            const ownMerge = await enqueueJob(sqliteDb(db), {
              queue: JOB_KIND.merge,
              payload: { itemId: "reverify" },
              now: clock.now(),
            });
            const expected = ids.map((id) =>
              id === "keep"
                ? { type: "keep_place" as const, mergeCallInFlight: inFlight }
                : { type: "reverify" as const },
            );

            expect(await recoverOnStartup(sqliteDb(db), clock.now())).toEqual(expected);
            expect((await getJob(sqliteDb(db), ownMerge))?.status).toBe("cancelled");
            for (let repeat = 0; repeat < 2; repeat++) {
              clock.advance(1);
              await recoverOnStartup(sqliteDb(db), clock.now());
              await applyDecision(
                sqliteDb(db),
                getWorkItem(db, "reverify")!,
                { type: "reverify" },
                clock.now(),
              );
              expect(await getJob(sqliteDb(db), mergeId)).toEqual(savedJob);
              expect(getWorkItem(db, "keep")).toEqual(savedItem);
              expect(db.query("SELECT * FROM merge_call WHERE item_id = ?").get("keep")).toEqual(
                savedMarker,
              );
              expect(
                (await listJobs(sqliteDb(db))).filter(
                  (job) => (job.payload as { itemId?: string }).itemId === "keep",
                ),
              ).toEqual([savedJob!]);
            }
            db.close();
          });
        }
      }
    }
  }

  test("a queued task whose run is still active at shutdown re-verifies", async () => {
    const { db, clock } = harness();
    const item = insertQueuedItem(db, { id: "eng-busy", now: clock.now() });
    const { run } = await beginImplementRun(sqliteDb(db), item.id, clock.now(), checkpoint);
    await enterMergeQueue(sqliteDb(db), item.id, checkpoint);

    await prepareShutdown(sqliteDb(db), clock.now());
    expect(getRun(db, run.id)?.status).toBe("lost");
    expect(await recoverOnStartup(sqliteDb(db), clock.now())).toEqual([{ type: "reverify" }]);
    expect(getWorkItem(db, item.id)?.state).toBe("verifying");
  });

  test("a merge job the shutdown ended is queued again, and asks GitHub after a merge call", async () => {
    const { db, clock } = harness();
    const item = insertQueuedItem(db, { id: "eng-2", now: clock.now() });
    const { run } = await beginImplementRun(sqliteDb(db), item.id, clock.now(), checkpoint);
    await enterMergeQueue(sqliteDb(db), item.id, checkpoint);
    await markRun(sqliteDb(db), run.id, "ended", clock.now());
    await enqueueJob(sqliteDb(db), {
      queue: "github.merge",
      payload: { itemId: item.id, head: "abc", summary: "Closeout accepted." },
      now: clock.now(),
    });
    const leased = (await claimNextJob(sqliteDb(db), { workerId: "merger", now: clock.now() }))!;
    await completeJob(sqliteDb(db), leased, clock.now());
    beginMergeCall(db, item.id, "abc", clock.now());

    expect(await recoverOnStartup(sqliteDb(db), clock.now())).toEqual([
      { type: "keep_place", mergeCallInFlight: true },
    ]);
    expect(getWorkItem(db, item.id)?.state).toBe("merge_queue");
    expect(
      (await listJobs(sqliteDb(db)))
        .filter((job) => job.status === "pending")
        .map((job) => [job.queue, job.payload]),
    ).toEqual([
      [
        "github.merge",
        { itemId: item.id, head: "abc", summary: "Closeout accepted.", mergeCallInFlight: true },
      ],
    ]);
  });

  test("a restart during the re-verify of a queued task re-verifies it again", async () => {
    const { db, clock } = harness();
    const item = insertQueuedItem(db, { id: "eng-twice", now: clock.now() });
    const { run } = await beginImplementRun(sqliteDb(db), item.id, clock.now(), checkpoint);
    await enterMergeQueue(sqliteDb(db), item.id, checkpoint);
    await markRun(sqliteDb(db), run.id, "ended", clock.now());
    await applyWorkItemEvent(sqliteDb(db), item.id, "reverify_requested");

    expect(await recoverOnStartup(sqliteDb(db), clock.now())).toEqual([{ type: "reverify" }]);
    expect(getWorkItem(db, item.id)?.state).toBe("verifying");
    db.run("UPDATE job SET status='done', finished_at=? WHERE queue='run.reverify'", [clock.now()]);
    await applyWorkItemEvent(sqliteDb(db), item.id, "closeout_accepted");
    clock.advance(10 * 60_000);

    expect(await recoverOnStartup(sqliteDb(db), clock.now())).toEqual([
      { type: "keep_place", mergeCallInFlight: false },
    ]);
    expect(getWorkItem(db, item.id)?.state).toBe("merge_queue");
    expect(
      (await listJobs(sqliteDb(db))).filter(
        (job) => job.queue === "run.reverify" && job.status === "pending",
      ),
    ).toHaveLength(0);
  });

  test("a question that is waiting for Linear survives a restart", async () => {
    const { db, clock } = harness();
    const item = insertQueuedItem(db, { now: clock.now() });
    const { run } = await beginImplementRun(sqliteDb(db), item.id, clock.now());
    await applyWorkItemEvent(sqliteDb(db), item.id, "blocking_question");
    saveCheckpoint(db, item.id, { ...checkpoint, phase: "awaiting_input" });
    expect(await recoverOnStartup(sqliteDb(db), clock.now())).toEqual([{ type: "none" }]);
    expect(getWorkItem(db, item.id)?.state).toBe("awaiting_input");
    expect(getWorkItem(db, item.id)?.recoveryAttempts).toBe(0);
    expect(getRun(db, run.id)?.status).toBe("ended");
    expect((await listJobs(sqliteDb(db))).map((job) => job.queue)).toEqual([JOB_KIND.catchup]);
  });

  test("a restart leaves an answered item to its pending answer resume", async () => {
    const { db, clock } = harness();
    const item = insertQueuedItem(db, { id: "answered", sessionKey: "ses", now: clock.now() });
    const { run } = await beginImplementRun(sqliteDb(db), item.id, clock.now(), checkpoint);
    await applyWorkItemEvent(sqliteDb(db), item.id, "blocking_question");
    await markRun(sqliteDb(db), run.id, "ended", clock.now());
    await applyWorkItemEvent(sqliteDb(db), item.id, "answer_received");
    enqueueJobOnce(db, {
      queue: JOB_KIND.resume,
      jobKey: "resume:answer:q-1",
      payload: { itemId: item.id, freshSession: true, reason: "answer", handoff: "Q and A" },
      now: clock.now(),
    });
    expect(await recoverOnStartup(sqliteDb(db), clock.now() + 1)).toEqual([]);
    expect(getWorkItem(db, item.id)).toMatchObject({ state: "running", recoveryAttempts: 0 });
    expect((await listJobs(sqliteDb(db))).map((job) => job.jobKey)).toEqual(["resume:answer:q-1"]);
  });

  test("illegal transitions do not change the row", async () => {
    const { db, clock } = harness();
    const item = insertQueuedItem(db, { now: clock.now() });
    await expect(applyWorkItemEvent(sqliteDb(db), item.id, "merge_accepted")).rejects.toThrow(
      TransitionRejectedError,
    );
    expect(getWorkItem(db, item.id)?.state).toBe("queued");
  });

  test("a new process resumes a running item once and does not post a duplicate activity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paws-runtime-"));
    const path = join(dir, "paws.db");
    const clock = new FakeClock(0);
    // Migrating a file commits once per migration, which overran 5 s on a
    // loaded disk. The first process works in memory and leaves one file.
    const first = openDatabase(":memory:");
    migrate(first);
    insertQueuedItem(first, { id: "eng-1", sessionKey: "ses", now: clock.now() });
    const { run } = await beginImplementRun(sqliteDb(first), "eng-1", clock.now(), checkpoint);
    await saveRunResult(sqliteDb(first), run.id, "Implemented and checked locally.", clock.now());
    first.run("VACUUM INTO ?", [path]);
    first.close();

    const second = openDatabase(path);
    migrate(second);
    const recovery = await recoverOnStartup(sqliteDb(second), clock.now());
    expect(getWorkItem(second, "eng-1")).toMatchObject({
      state: "recovering",
      recoveryAttempts: 1,
    });
    expect(getRun(second, run.id)?.status).toBe("active");
    expect(getRun(second, run.id)?.checkpoint?.resultBody).toBe("Implemented and checked locally.");
    expect(recovery).toEqual([{ type: "resume", freshSession: true, checkpoint }]);
    expect(await listOutbox(sqliteDb(second))).toHaveLength(0);
    expect(
      (await listJobs(sqliteDb(second))).filter((job) => job.queue === JOB_KIND.resume),
    ).toHaveLength(1);
    second.close();
  });
});

describe("hard caps", () => {
  test("stored turn columns from older installs do not cap work", async () => {
    const { db, clock } = harness();
    const item = insertQueuedItem(db, { maxAwakeMs: 1_000, now: clock.now() });
    await beginImplementRun(sqliteDb(db), item.id, clock.now());
    db.run("UPDATE work_item SET turn_count = 100, max_turns = 1 WHERE id = ?", [item.id]);
    await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now(), undefined, true);
    clock.advance(400);
    expect(
      (await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now(), undefined, true)).capped,
    ).toBe(false);
    expect(getWorkItem(db, item.id)?.state).toBe("running");
    expect(await listOutbox(sqliteDb(db))).toHaveLength(0);
  });

  test("awake time counts monotonic time and ignores a wall-clock sleep", async () => {
    const { clock, db } = harness();
    const item = insertQueuedItem(db, { maxAwakeMs: 1_000, now: clock.now() });
    db.run("UPDATE work_item SET session_key = NULL WHERE id = ?", [item.id]);
    await beginImplementRun(sqliteDb(db), item.id, clock.now());
    await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now(), undefined, true);
    clock.sleep(3 * 60 * 60_000);
    clock.advance(400);
    expect(
      (await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now(), undefined, true)).item
        .awakeMs,
    ).toBe(400);
    expect(getWorkItem(db, item.id)?.state).toBe("running");
    clock.advance(600);
    expect(
      (await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now(), undefined, true)).capped,
    ).toBe(true);
    expect(getWorkItem(db, item.id)?.state).toBe("failed");
    expect((await listOutbox(sqliteDb(db)))[0]?.payload).toEqual({
      sessionId: item.id,
      kind: "error",
      body: "Implementation reached its 1 min limit. Counted: implementation under 1 min.",
    });
  });

  test("time parked for a Linear answer is not awake time", async () => {
    const { clock, db } = harness();
    const item = insertQueuedItem(db, { maxAwakeMs: 50_000, now: clock.now() });
    await beginImplementRun(sqliteDb(db), item.id, clock.now());
    await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now(), undefined, true);
    await applyWorkItemEvent(sqliteDb(db), item.id, "blocking_question");
    clock.advance(10_000);
    await syncClock(sqliteDb(db), item.id, clock.mono());
    await applyWorkItemEvent(sqliteDb(db), item.id, "answer_received");
    clock.advance(100);
    expect(
      (await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now(), undefined, true)).item
        .awakeMs,
    ).toBe(100);
  });

  test("time waiting in the merge queue is not awake time", async () => {
    const { clock, db } = harness();
    const item = insertQueuedItem(db, { maxAwakeMs: 1_000, now: clock.now() });
    await beginImplementRun(sqliteDb(db), item.id, clock.now());
    await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now(), undefined, true);
    await applyWorkItemEvent(sqliteDb(db), item.id, "turn_ended");
    await applyWorkItemEvent(sqliteDb(db), item.id, "closeout_accepted");
    clock.advance(4 * 60 * 60_000);
    const result = await accrueAwake(
      sqliteDb(db),
      item.id,
      clock.mono(),
      clock.now(),
      undefined,
      true,
    );
    expect(result.capped).toBe(false);
    expect(result.item.awakeMs).toBe(0);
    expect(getWorkItem(db, item.id)?.state).toBe("merge_queue");
  });

  test("re-checking a candidate Closeout accepted is not awake time", async () => {
    const { clock, db } = harness();
    const item = insertQueuedItem(db, { maxAwakeMs: 1_000, now: clock.now() });
    await beginImplementRun(sqliteDb(db), item.id, clock.now());
    await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now(), undefined, true);
    await applyWorkItemEvent(sqliteDb(db), item.id, "turn_ended");
    await applyWorkItemEvent(sqliteDb(db), item.id, "closeout_accepted");
    saveCheckpoint(db, item.id, { phase: "merge_queue", baseSha: "base", wipCommit: "head" });
    await applyWorkItemEvent(sqliteDb(db), item.id, "reverify_requested");
    clock.advance(4 * 60 * 60_000);
    const result = await accrueAwake(
      sqliteDb(db),
      item.id,
      clock.mono(),
      clock.now(),
      undefined,
      true,
    );
    expect(result.capped).toBe(false);
    expect(result.item.awakeMs).toBe(0);
    expect(getWorkItem(db, item.id)?.state).toBe("verifying");
  });

  test("an accepted task sent back to the agent counts awake time again", async () => {
    const { clock, db } = harness();
    const item = insertQueuedItem(db, { limits: { fixes: 1_000 }, now: clock.now() });
    await beginImplementRun(sqliteDb(db), item.id, clock.now());
    await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now(), undefined, true);
    await applyWorkItemEvent(sqliteDb(db), item.id, "turn_ended");
    await applyWorkItemEvent(sqliteDb(db), item.id, "closeout_accepted");
    saveCheckpoint(db, item.id, { phase: "merge_queue", baseSha: "base", wipCommit: "head" });
    await applyWorkItemEvent(sqliteDb(db), item.id, "restart", {
      kind: "restart",
      reason: "review",
    });
    await applyWorkItemEvent(sqliteDb(db), item.id, "dispatched");
    // The merge queue dropped the baseline; the supervisor's next tick starts the clock again.
    await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now(), undefined, true);
    clock.advance(2_000);
    expect(
      (await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now(), undefined, true)).asked,
    ).toBe(true);
  });
});

describe("linear commands", () => {
  test("a stop is applied before the call returns", async () => {
    const { db, clock } = harness();
    const seen: string[] = [];
    const bus = new CommandBus();
    bus.subscribe((command) => {
      seen.push(command.type);
    });
    insertQueuedItem(db, { id: "eng-2", sessionKey: "ses", now: clock.now() });
    const { run } = await beginImplementRun(sqliteDb(db), "eng-2", clock.now());
    await recordItemBranchState(sqliteDb(db), {
      itemId: "eng-2",
      runId: run.id,
      head: "b".repeat(40),
      base: "a".repeat(40),
      commits: 3,
      recordedAt: clock.now(),
    });
    await recordItemPullRequest(sqliteDb(db), {
      itemId: "eng-2",
      pullNumber: 7,
      pullUrl: null,
      openedAt: 1,
    });
    await enqueueJob(sqliteDb(db), {
      queue: "github.merge",
      payload: { itemId: "eng-2" },
      now: clock.now(),
    });
    const merge = await claimNextJob(sqliteDb(db), {
      workerId: "merger",
      now: clock.now(),
      queues: ["github.merge"],
    });

    const result = await submitCommand(sqliteDb(db), bus, {
      type: "stop",
      source: "linear",
      itemId: "eng-2",
      requestedAt: clock.now(),
    });

    expect(result.applied).toBe(true);
    expect(seen).toEqual(["stop"]);
    expect(getWorkItem(db, "eng-2")).toMatchObject({ state: "paused", cancelRequested: false });
    expect(getRun(db, run.id)?.status).not.toBe("active");
    expect((await listOutbox(sqliteDb(db))).find((row) => row.op === "activity")?.payload).toEqual({
      sessionId: "ses",
      kind: "response",
      body: "Paused. Reply here or re-delegate to continue.",
      id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    });
    expect(merge).not.toBeNull();
    expect(merge !== null && (await completeJob(sqliteDb(db), merge, clock.now()))).toBe(false);
    expect((await getItemPullRequest(sqliteDb(db), "eng-2"))?.pullNumber).toBe(7);
    expect(
      (await listJobs(sqliteDb(db))).some((job) => job.queue === JOB_KIND.closeStoppedPull),
    ).toBe(false);

    await submitCommand(sqliteDb(db), bus, {
      type: "stop",
      source: "linear",
      itemId: "eng-2",
      requestedAt: clock.now() + 1,
    });
    expect((await listOutbox(sqliteDb(db))).map((row) => row.op)).toEqual(["activity"]);

    expect(
      (
        await submitCommand(sqliteDb(db), bus, {
          type: "stop",
          source: "dashboard",
          itemId: "eng-2",
          requestedAt: clock.now() + 2,
        })
      ).applied,
    ).toBe(true);
    expect(getWorkItem(db, "eng-2")).toMatchObject({ state: "cancelled", cancelRequested: true });
  });

  test("a Linear stop in the merge queue pauses the item and holds its merge", async () => {
    const { db, clock } = harness();
    insertQueuedItem(db, { id: "eng-3", sessionKey: "ses", now: clock.now() });
    await beginImplementRun(sqliteDb(db), "eng-3", clock.now());
    await applyWorkItemEvent(sqliteDb(db), "eng-3", "turn_ended");
    await applyWorkItemEvent(sqliteDb(db), "eng-3", "closeout_accepted");
    await enqueueJob(sqliteDb(db), {
      queue: "github.merge",
      payload: { itemId: "eng-3" },
      now: clock.now(),
    });

    await submitCommand(sqliteDb(db), new CommandBus(), {
      type: "stop",
      source: "linear",
      itemId: "eng-3",
      requestedAt: clock.now(),
    });

    expect(getWorkItem(db, "eng-3")?.state).toBe("paused");
    expect(
      await claimNextJob(sqliteDb(db), {
        workerId: "m",
        now: clock.now(),
        queues: ["github.merge"],
      }),
    ).toBe(null);
  });

  test("a stop names the commits left on the branch and the open pull request", async () => {
    const { db, clock } = harness();
    insertQueuedItem(db, { id: "eng-5", sessionKey: "ses", now: clock.now() });
    const { run } = await beginImplementRun(sqliteDb(db), "eng-5", clock.now());
    await recordItemBranchState(sqliteDb(db), {
      itemId: "eng-5",
      runId: run.id,
      head: "b".repeat(40),
      base: "a".repeat(40),
      commits: 1,
      recordedAt: clock.now(),
    });
    await recordItemPullRequest(sqliteDb(db), {
      itemId: "eng-5",
      pullNumber: 12,
      pullUrl: null,
      openedAt: 1,
    });
    await submitCommand(sqliteDb(db), new CommandBus(), {
      type: "stop",
      source: "dashboard",
      itemId: "eng-5",
      requestedAt: clock.now(),
    });
    const rows = await listOutbox(sqliteDb(db));
    expect(rows.map((row) => row.delivery)).toEqual(["stop", "stop"]);
    expect(rows.some((row) => row.op === "status")).toBe(false);
    expect(rows.find((row) => row.op === "activity")?.payload).toMatchObject({
      kind: "response",
      body: "Stopped from Paws. Branch paws/eng-5 has 1 commit; PR #12 stays open. Re-delegate to continue.",
    });
    expect(rows.find((row) => row.op === "linear.session.plan")?.payload).toMatchObject({
      sessionId: "ses",
      summary: `${getWorkItem(db, "eng-5")!.linearIdentifier}: stopped`,
    });
    db.close();
  });

  test("a stop without a pull request says none was opened and cancels the remaining plan", async () => {
    const { db, clock } = harness();
    insertQueuedItem(db, { id: "eng-6", sessionKey: "ses", now: clock.now() });
    const identifier = getWorkItem(db, "eng-6")!.linearIdentifier;
    await beginImplementRun(sqliteDb(db), "eng-6", clock.now());
    db.run(
      `INSERT INTO outbox (target, op, ordering_key, idempotency_key, payload, priority, not_before,
         created_at, max_attempts, delivery_kind, delivery_generation, status)
       VALUES ('linear', 'linear.session.plan', 'ses', 'plan-1', ?, 6, 0, 0, 5, 'ordered', 0, 'sent')`,
      [
        JSON.stringify({
          sessionId: "ses",
          identifier,
          plan: [
            { content: "Read the code", status: "completed" },
            { content: "Change it", status: "inProgress" },
            { content: "Verify changes", status: "pending" },
          ],
        }),
      ],
    );
    await submitCommand(sqliteDb(db), new CommandBus(), {
      type: "stop",
      source: "dashboard",
      itemId: "eng-6",
      requestedAt: clock.now(),
    });
    const stop = (await listOutbox(sqliteDb(db))).filter((row) => row.delivery === "stop");
    expect(stop.find((row) => row.op === "activity")?.payload).toMatchObject({
      kind: "response",
      body: "Stopped from Paws. Branch paws/eng-6 has no commits; no PR was opened. Re-delegate to continue.",
    });
    expect(stop.find((row) => row.op === "linear.session.plan")?.payload).toMatchObject({
      summary: `${identifier}: stopped`,
      plan: [
        { content: "Read the code", status: "completed" },
        { content: "Change it", status: "canceled" },
        { content: "Verify changes", status: "canceled" },
      ],
    });
    db.close();
  });

  test("a cancel with an outside reason names the branch only when work is left on it", async () => {
    const { db, clock } = harness();
    insertQueuedItem(db, { id: "eng-7", sessionKey: "ses-7", now: clock.now() });
    insertQueuedItem(db, { id: "eng-8", sessionKey: "ses-8", now: clock.now() });
    const { run } = await beginImplementRun(sqliteDb(db), "eng-8", clock.now());
    await recordItemBranchState(sqliteDb(db), {
      itemId: "eng-8",
      runId: run.id,
      head: "b".repeat(40),
      base: "a".repeat(40),
      commits: 2,
      recordedAt: clock.now(),
    });
    for (const itemId of ["eng-7", "eng-8"])
      await applyLinearCommand(
        sqliteDb(db),
        { type: "cancel", source: "linear", itemId, requestedAt: clock.now() },
        clock.now(),
        "Closed: the issue was canceled in Linear.",
      );
    expect(
      (await listOutbox(sqliteDb(db)))
        .filter((row) => row.op === "activity")
        .map((row) => (row.payload as { body: string }).body),
    ).toEqual([
      "Closed: the issue was canceled in Linear.",
      "Closed: the issue was canceled in Linear. Branch paws/eng-8 has 2 commits; no PR was opened.",
    ]);
    db.close();
  });

  test("a take over ends the session with who took it and the manual title", async () => {
    const { db, clock } = harness();
    insertQueuedItem(db, { id: "eng-9", sessionKey: "ses", now: clock.now() });
    const identifier = getWorkItem(db, "eng-9")!.linearIdentifier;
    await beginImplementRun(sqliteDb(db), "eng-9", clock.now());
    expect((await takeOverItem(sqliteDb(db), "eng-9", "Ada", clock.now())).applied).toBe(false);
    await applyWorkItemEvent(sqliteDb(db), "eng-9", "run_failed");
    const version = getWorkItem(db, "eng-9")!.version;
    expect((await takeOverItem(sqliteDb(db), "eng-9", "Ada", clock.now())).applied).toBe(true);
    expect(getWorkItem(db, "eng-9")).toMatchObject({ state: "manual" });
    expect(getWorkItem(db, "eng-9")!.version).toBeGreaterThan(version + 1);
    const stop = (await listOutbox(sqliteDb(db))).filter((row) => row.delivery === "stop");
    expect(stop.find((row) => row.op === "activity")?.payload).toMatchObject({
      kind: "response",
      body: `Taken over by Ada. Paws will not restart, verify or merge ${identifier}.`,
    });
    expect(stop.find((row) => row.op === "linear.session.plan")?.payload).toMatchObject({
      summary: `${identifier}: manual`,
    });
    db.close();
  });

  test("a shared session receives one final stop acknowledgement", async () => {
    const { db, clock } = harness();
    const bus = new CommandBus();
    for (const id of ["first", "second"]) {
      insertQueuedItem(db, { id, sessionKey: "ses", now: clock.now() });
      await submitCommand(sqliteDb(db), bus, {
        type: "stop",
        source: "linear",
        itemId: id,
        requestedAt: clock.now(),
      });
    }
    const activities = (await listOutbox(sqliteDb(db))).filter((row) => row.op === "activity");
    expect(activities).toHaveLength(1);
    expect(activities[0]?.payload).toMatchObject({ kind: "response", sessionId: "ses" });
    db.close();
  });

  test("a listener error stays on the command and the item stays cancelled", async () => {
    const { db, clock } = harness();
    const bus = new CommandBus();
    bus.subscribe(() => {
      throw new Error("listener blew up");
    });
    insertQueuedItem(db, { id: "eng-4", now: clock.now() });
    await beginImplementRun(sqliteDb(db), "eng-4", clock.now());
    await submitCommand(sqliteDb(db), bus, {
      type: "cancel",
      source: "linear",
      itemId: "eng-4",
      requestedAt: clock.now(),
    });
    expect(getWorkItem(db, "eng-4")?.state).toBe("cancelled");
    expect(
      (await listJobs(sqliteDb(db))).find((job) => job.queue === JOB_KIND.command)?.lastError,
    ).toBe("listener blew up");
  });
});
