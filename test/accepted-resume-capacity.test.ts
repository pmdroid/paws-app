import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { FakeClock, JOB_KIND } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  applyWorkItemEvent,
  beginImplementRun,
  bindWorkItemRepository,
  enqueueJob,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  markCloseoutAccepted,
  recordItemPullRequest,
  saveCheckpoint,
} from "../src/db";
import { attachOrchestrator } from "../src/loop";
import { tempDb, tempHome } from "./helpers";

for (const state of ["recovering", "merge_queue"] as const)
  test(`an accepted ${state} resume does not wait for or reserve runner capacity`, async () => {
    const db = tempDb();
    const root = tempHome();
    const clock = new FakeClock(1000);
    const jobs = new JobLoop(db, clock);
    const head = "a".repeat(40);
    const item = insertQueuedItem(db, { now: clock.now() });
    beginImplementRun(db, item.id, clock.now());
    applyWorkItemEvent(db, item.id, "turn_ended");
    applyWorkItemEvent(db, item.id, "closeout_accepted");
    markCloseoutAccepted(db, item.id, head);
    saveCheckpoint(db, item.id, { phase: "merge_queue", baseSha: head, wipCommit: head });
    if (state === "recovering") {
      applyWorkItemEvent(db, item.id, "ejected");
      applyWorkItemEvent(db, item.id, "lease_expired");
    }
    bindWorkItemRepository(db, item.id, {
      owner: "acme",
      repo: "app",
      remoteUrl: "https://github.com/acme/app.git",
    });
    recordItemPullRequest(db, {
      itemId: item.id,
      pullNumber: 1,
      pullUrl: null,
      openedAt: clock.now(),
    });
    let reservations = 0;
    const noAgent = async (): Promise<never> => {
      throw new Error("Merge resume must not start an agent");
    };
    const orchestrator = attachOrchestrator({
      db,
      jobs,
      outbox: new OutboxDispatcher(db, clock),
      clock,
      pawsRoot: root,
      githubForRepository: () => ({
        appId: "fixture",
        installationId: "fixture",
        privateKeyPem: "unused",
        tokenProvider: { mode: "app", tokenFor: async () => "fixture" },
        client: {
          async request() {
            return {
              status: 200,
              body: { state: "open", head: { sha: head, repo: { full_name: "acme/app" } } },
            };
          },
        },
      }),
      remoteExecution: {
        tryReserve() {
          reservations++;
          return { ok: false, runnerIds: ["busy"] };
        },
        agentForItem: () => noAgent,
        agentForSession: () => noAgent,
      },
    });
    try {
      enqueueJob(db, {
        queue: JOB_KIND.resume,
        now: clock.now(),
        payload: {
          itemId: item.id,
          reason: "transient_failure",
          capacityWait: { since: clock.now(), attempt: 0, runnerIds: ["busy"] },
        },
      });
      await jobs.tick([JOB_KIND.resume]);
      expect(reservations).toBe(0);
      expect(getWorkItem(db, item.id)?.state).toBe("merge_queue");
      expect(
        listJobs(db).filter((job) => job.queue === JOB_KIND.resume && job.status === "pending"),
      ).toHaveLength(0);
      if (state === "recovering")
        expect(listJobs(db).some((job) => job.queue === JOB_KIND.merge)).toBe(true);
    } finally {
      await orchestrator.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

test("a running resume waits its configured delay without recovery jitter", async () => {
  const db = tempDb();
  const root = tempHome();
  const clock = new FakeClock(1000);
  const jobs = new JobLoop(db, clock);
  const item = insertQueuedItem(db, { now: clock.now() });
  beginImplementRun(db, item.id, clock.now());
  const noAgent = async (): Promise<never> => {
    throw new Error("A full runner must park the job");
  };
  const orchestrator = attachOrchestrator({
    db,
    jobs,
    outbox: new OutboxDispatcher(db, clock),
    clock,
    pawsRoot: root,
    placementPollMs: 1000,
    random() {
      throw new Error("Only recovering admission should draw jitter");
    },
    remoteExecution: {
      tryReserve: () => ({ ok: false, runnerIds: ["busy"] }),
      agentForItem: () => noAgent,
      agentForSession: () => noAgent,
    },
  });
  try {
    enqueueJob(db, { queue: JOB_KIND.resume, now: clock.now(), payload: { itemId: item.id } });
    await jobs.tick([JOB_KIND.resume]);
    const pending = listJobs(db).filter(
      (job) => job.queue === JOB_KIND.resume && job.status === "pending",
    );
    expect(pending).toHaveLength(1);
    // The first placement wait is twenty polling intervals.
    expect(pending[0]!.runAt).toBe(clock.now() + 20_000);
  } finally {
    await orchestrator.shutdown();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
