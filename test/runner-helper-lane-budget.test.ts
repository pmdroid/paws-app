import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { runAgent } from "../src/acp";
import { RunnerSlotsBusyError, systemClock } from "../src/core";
import { eq } from "drizzle-orm";
import { JobLoop, OutboxDispatcher, getWorkItem, listJobs, listWorkItems } from "../src/db";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { attachOrchestrator } from "../src/loop";
import { tempHome } from "./helpers";
import { workspaceAdmission } from "./fake-workspace";
import { tempStore } from "./pglite";

const event: AcceptedLinearEvent = {
  dedupeKey: "created",
  deliveryId: null,
  source: "webhook",
  action: "created",
  sessionId: "session",
  issueId: "issue",
  activityId: null,
  body: null,
  signal: null,
  updatedAtMs: 1,
  payload: JSON.stringify({ agentSession: { creatorId: "human" } }),
};

test("a busy helper lane leaves the start attempts alone and a failing helper spends one", async () => {
  const home = tempHome();
  const root = join(home, "paws");
  mkdirSync(root);
  const { db, close } = await tempStore();
  const tracker = createFakeTracker([
    {
      linearIssueId: "issue",
      identifier: "ENG-1",
      title: "Explain the queue",
      description: null,
      subIssues: [],
    },
  ]);
  let outcome: Error = new RunnerSlotsBusyError(
    "Queued: the runner's helper lane is busy. Paws retries when it frees.",
  );
  let intake = true;
  const helperCalls: string[] = [];
  const failing = (purpose: string) => async (_options: Parameters<typeof runAgent>[0]) => {
    helperCalls.push(purpose);
    throw outcome;
  };
  const jobs = new JobLoop(db, systemClock);
  const outbox = new OutboxDispatcher(db, systemClock);
  const orchestrator = attachOrchestrator({
    store: db,
    admission: workspaceAdmission(db),
    jobs,
    outbox,
    home,
    pawsRoot: root,
    tracker,
    linearTaskModes: true,
    launch: () => {
      throw new Error("Remote execution must not launch a local agent");
    },
    remoteExecution: {
      slotFree: async () => !intake,
      agentForSession: (_sessionId, purpose) => failing(purpose),
      agentForItem: () => failing("work"),
    },
  });
  const runnable = () =>
    db.run((q) =>
      q.exec(q.orm.update(q.t.job).set({ runAt: 0 }).where(eq(q.t.job.status, "pending"))),
    );
  const attempts = async () =>
    (await listJobs(db)).filter((job) => job.status === "pending").map((job) => job.attempts);
  try {
    await orchestrator.onLinearEvent(event);
    intake = false;
    const itemId = (await listWorkItems(db))[0]!.id;
    for (let wait = 0; wait < 3; wait++) {
      await runnable();
      await jobs.tick();
    }
    expect(helperCalls).toEqual(["classify", "classify", "classify"]);
    expect((await getWorkItem(db, itemId))?.state).toBe("recovering");
    expect(await attempts()).toEqual([0]);

    outcome = new Error("Remote session helper timed out");
    helperCalls.length = 0;
    await runnable();
    await jobs.tick();
    expect(helperCalls).toEqual(["classify"]);
    expect(await attempts()).toEqual([1]);
    expect((await getWorkItem(db, itemId))?.state).not.toBe("failed");
  } finally {
    await orchestrator.shutdown().catch(() => undefined);
    await outbox.idle();
    await close();
  }
}, 20_000);
