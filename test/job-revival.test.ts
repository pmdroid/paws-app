import { expect, test } from "bun:test";
import {
  JobLoop,
  applyWorkItemEvent,
  beginImplementRun,
  bindWorkItemRepository,
  claimNextJob,
  completeJob,
  enqueueJob,
  fixRounds,
  getJob,
  getWorkItem,
  humanRetryBaseline,
  insertQueuedItem,
  jobVersionCurrent,
  latestHumanTurn,
  listRebaseReturns,
  recordRebaseReturn,
  reenqueueJob,
  restart,
  saveHumanRetryWindow,
  type Db,
} from "../src/db";
import { eq } from "drizzle-orm";
import { FakeClock, JOB_KIND } from "../src/core";
import { enqueueVerifiedMerge } from "../src/loop";
import { rebaseReturns } from "../src/merge";
import { workspaceDispatchPg } from "./fake-workspace";
import { tempStore } from "./pglite";

const setJobStatus = (db: Db, id: number, status: string) =>
  db.run((q) => q.exec(q.orm.update(q.t.job).set({ status }).where(eq(q.t.job.id, id))));

async function fixture() {
  const store = await tempStore();
  const db = store.db;
  await insertQueuedItem(db, { id: "item", now: 0 });
  await bindWorkItemRepository(db, "item", {
    owner: "owner",
    repo: "repo",
    remoteUrl: "https://example.invalid/repo.git",
  });
  await beginImplementRun(db, "item", 1);
  return store;
}

test("a cancelled resume handler stays fenced while its revived row runs a new handler", async () => {
  const { db, close } = await fixture();
  const clock = new FakeClock(2);
  const id = await enqueueJob(db, {
    queue: JOB_KIND.resume,
    jobKey: "same-head-ci",
    payload: { itemId: "item", handoff: "old" },
    now: 2,
  });
  const loop = new JobLoop(db, clock);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let staleChecks: boolean[] = [];
  const writes: string[] = [];
  loop.register(JOB_KIND.resume, async (job, context) => {
    if ((job.payload as { handoff: string }).handoff === "old") {
      await gate;
      staleChecks = [await context.isCurrent(), await jobVersionCurrent(db, job)];
      if (staleChecks.some(Boolean)) writes.push("stale");
    } else {
      expect(await context.isCurrent()).toBe(true);
      expect(await jobVersionCurrent(db, job)).toBe(true);
      writes.push("new");
    }
  });
  const oldTick = loop.tick([JOB_KIND.resume]);
  const old = (await getJob(db, id))!;
  expect(old.status).toBe("running");
  expect(
    await restart(db, (await getWorkItem(db, "item"))!, {
      reason: "ci",
      body: "new",
      jobKey: "same-head-ci",
      now: 3,
    }),
  ).toBe(id);
  expect(await jobVersionCurrent(db, old)).toBe(false);
  clock.advance(2);
  await workspaceDispatchPg(db, { now: clock.now() });
  await loop.tick([JOB_KIND.resume]);
  release();
  await oldTick;
  expect(staleChecks).toEqual([false, false]);
  expect(writes).toEqual(["new"]);
  expect((await getJob(db, id))?.status).toBe("done");
  await close();
});

test.each(["done", "cancelled", "dead"] as const)(
  "reviving a %s merge row never refreshes the old handler's fence",
  async (status) => {
    const { db, close } = await fixture();
    await applyWorkItemEvent(db, "item", "turn_ended");
    await applyWorkItemEvent(db, "item", "closeout_accepted");
    const input = { itemId: "item", head: "head", summary: "accepted", now: 2 };
    const id = await enqueueVerifiedMerge(db, input);
    const old = (await claimNextJob(db, { now: 2, queues: [JOB_KIND.merge] }))!;
    await setJobStatus(db, id, status);
    expect(await enqueueVerifiedMerge(db, { ...input, now: 3 })).toBe(id);
    expect(await jobVersionCurrent(db, old)).toBe(false);
    const current = (await claimNextJob(db, { now: 3, queues: [JOB_KIND.merge] }))!;
    expect(current.id).toBe(old.id);
    expect(current.activationId).toBeGreaterThan(old.activationId);
    expect(await jobVersionCurrent(db, old)).toBe(false);
    expect(await jobVersionCurrent(db, current)).toBe(true);
    expect(await completeJob(db, old, 4)).toBe(false);
    expect(await getJob(db, id)).toEqual(current);
    await close();
  },
);

test.each(["linear", "answer"] as const)(
  "revived %s human turns reset both budgets and preserve per-activation retry baselines and returns",
  async (kind) => {
    const { db, close } = await fixture();
    let now = 2;
    const admit = async (key: string, reason: "ci" | "follow_up" | "answer") =>
      (await restart(db, (await getWorkItem(db, "item"))!, {
        reason,
        body: key,
        jobKey: key,
        now: now++,
      }))!;
    const key = (turn: number) =>
      kind === "linear" ? `linear-turn:s:${turn}` : `resume:answer:Q${turn}`;
    const reason = kind === "linear" ? "follow_up" : "answer";
    const first = await admit(key(1), reason);
    const oldActivation = (await getJob(db, first))!.activationId;
    await saveHumanRetryWindow(db, "item", first, ["first"]);
    await recordRebaseReturn(db, {
      itemId: "item",
      jobId: first,
      candidate: "a",
      reason: "linear",
    });
    await admit("same-head-ci", "ci");
    expect(await fixRounds(db, "item")).toBe(1);
    const second = await admit(key(2), reason);
    await saveHumanRetryWindow(db, "item", second, ["second"]);
    await recordRebaseReturn(db, {
      itemId: "item",
      jobId: second,
      candidate: "b",
      reason: "linear",
    });
    await admit("same-head-ci", "ci");
    expect(await fixRounds(db, "item")).toBe(1);
    const owner = (await getWorkItem(db, "item"))!;
    expect(await admit(key(1), reason)).toBe(first);
    expect(await fixRounds(db, "item")).toBe(0);
    expect(await rebaseReturns(db, "item")).toBe(0);
    expect((await getJob(db, first))!.activationId).toBeGreaterThan(
      (await getJob(db, second))!.activationId,
    );
    expect(await latestHumanTurn(db, "item")).toBe((await getJob(db, first))!.activationId);
    await saveHumanRetryWindow(db, "item", first, ["third"]);
    await saveHumanRetryWindow(db, "item", first, ["redispatch"]);
    expect(await humanRetryBaseline(db, "item")).toEqual(["third"]);
    await recordRebaseReturn(db, {
      itemId: "item",
      jobId: first,
      candidate: "c",
      reason: "linear",
    });
    await recordRebaseReturn(db, {
      itemId: "item",
      jobId: first,
      candidate: "replay",
      reason: "linear",
    });
    expect(await rebaseReturns(db, "item")).toBe(1);
    expect(await listRebaseReturns(db, "item", 0)).toHaveLength(3);
    expect(
      await db.run((q) =>
        q.all(
          q.orm
            .select({ activationId: q.t.closeoutRetryWindow.activationId })
            .from(q.t.closeoutRetryWindow)
            .where(eq(q.t.closeoutRetryWindow.jobId, first))
            .orderBy(q.t.closeoutRetryWindow.activationId),
        ),
      ),
    ).toEqual([
      { activationId: oldActivation },
      { activationId: (await getJob(db, first))!.activationId },
    ]);
    expect(await restart(db, owner, { reason, body: "replay", jobKey: key(1), now })).toBeNull();
    expect(await rebaseReturns(db, "item")).toBe(1);
    await admit("same-head-ci", "ci");
    expect(await fixRounds(db, "item")).toBe(1);
    await close();
  },
);

test("repeated non-human rebase returns count once per activation", async () => {
  const { db, close } = await fixture();
  for (const now of [2, 3]) {
    const id = (await restart(db, (await getWorkItem(db, "item"))!, {
      reason: "conflict",
      body: "rebase",
      jobKey: "conflict",
      now,
    }))!;
    for (let replay = 0; replay < 2; replay++)
      await recordRebaseReturn(db, {
        itemId: "item",
        jobId: id,
        candidate: "head",
        reason: "merge",
      });
    expect(await rebaseReturns(db, "item")).toBe(now - 1);
  }
  await close();
});

test("queue collisions roll back revival and fresh queue settings replace terminal settings", async () => {
  const { db, close } = await fixture();
  const id = await enqueueJob(db, {
    queue: "other",
    jobKey: "collision",
    payload: { itemId: "item" },
  });
  await setJobStatus(db, id, "done");
  const before = await getJob(db, id);
  const item = (await getWorkItem(db, "item"))!;
  await expect(
    restart(db, item, { reason: "ci", body: "bad", jobKey: "collision", now: 3 }),
  ).rejects.toThrow("different queue");
  expect(await getWorkItem(db, "item")).toEqual(item);
  expect(await getJob(db, id)).toEqual(before);
  await reenqueueJob(db, {
    queue: "other",
    jobKey: "collision",
    payload: { itemId: "item" },
    priority: 2,
    maxAttempts: 6,
    recurringEveryMs: 10,
    runAt: 20,
    now: 4,
  });
  expect(await getJob(db, id)).toMatchObject({
    priority: 2,
    maxAttempts: 6,
    recurringEveryMs: 10,
    runAt: 20,
  });
  await close();
});

test("a revived older human row captures a new baseline once and outranks later row IDs", async () => {
  const { db, close } = await fixture();
  const first = await enqueueJob(db, {
    queue: JOB_KIND.resume,
    jobKey: "resume:answer:first",
    payload: { itemId: "item", reason: "answer" },
    now: 2,
  });
  await saveHumanRetryWindow(db, "item", first, ["first"]);
  const second = await enqueueJob(db, {
    queue: JOB_KIND.resume,
    jobKey: "resume:answer:second",
    payload: { itemId: "item", reason: "answer" },
    now: 3,
  });
  await saveHumanRetryWindow(db, "item", second, ["second"]);
  await setJobStatus(db, first, "done");
  await reenqueueJob(db, {
    queue: JOB_KIND.resume,
    jobKey: "resume:answer:first",
    payload: { itemId: "item", reason: "answer" },
    now: 4,
  });
  await saveHumanRetryWindow(db, "item", first, ["new first"]);
  await saveHumanRetryWindow(db, "item", first, ["replayed"]);
  expect(await humanRetryBaseline(db, "item")).toEqual(["new first"]);
  await close();
});
