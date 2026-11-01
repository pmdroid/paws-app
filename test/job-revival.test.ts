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
  listRebaseReturns,
  migrate,
  migrations,
  openDatabase,
  recordRebaseReturn,
  reenqueueJob,
  restart,
  saveHumanRetryWindow,
} from "../src/db";
import { FakeClock, JOB_KIND } from "../src/core";
import { enqueueVerifiedMerge } from "../src/loop";
import { rebaseReturns, latestUserTurn } from "../src/merge";
import { tempDb } from "./helpers";
import { workspaceDispatch } from "./fake-workspace";

function fixture() {
  const db = tempDb();
  insertQueuedItem(db, { id: "item", now: 0 });
  bindWorkItemRepository(db, "item", {
    owner: "owner",
    repo: "repo",
    remoteUrl: "https://example.invalid/repo.git",
  });
  beginImplementRun(db, "item", 1);
  return db;
}

test("a cancelled resume handler stays fenced while its revived row runs a new handler", async () => {
  const db = fixture();
  const clock = new FakeClock(2);
  const id = enqueueJob(db, {
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
      staleChecks = [context.isCurrent(), jobVersionCurrent(db, job)];
      if (staleChecks.some(Boolean)) writes.push("stale");
    } else {
      expect(context.isCurrent()).toBe(true);
      expect(jobVersionCurrent(db, job)).toBe(true);
      writes.push("new");
    }
  });
  const oldTick = loop.tick([JOB_KIND.resume]);
  const old = getJob(db, id)!;
  expect(old.status).toBe("running");
  expect(
    restart(db, getWorkItem(db, "item")!, {
      reason: "ci",
      body: "new",
      jobKey: "same-head-ci",
      now: 3,
    }),
  ).toBe(id);
  expect(jobVersionCurrent(db, old)).toBe(false);
  clock.advance(2);
  workspaceDispatch(db, { now: clock.now() });
  await loop.tick([JOB_KIND.resume]);
  release();
  await oldTick;
  expect(staleChecks).toEqual([false, false]);
  expect(writes).toEqual(["new"]);
  expect(getJob(db, id)?.status).toBe("done");
  db.close();
});

test.each(["done", "cancelled", "dead"] as const)(
  "reviving a %s merge row never refreshes the old handler's fence",
  (status) => {
    const db = fixture();
    applyWorkItemEvent(db, "item", "turn_ended");
    applyWorkItemEvent(db, "item", "closeout_accepted");
    const input = { itemId: "item", head: "head", summary: "accepted", now: 2 };
    const id = enqueueVerifiedMerge(db, input);
    const old = claimNextJob(db, { now: 2, queues: [JOB_KIND.merge] })!;
    db.run("UPDATE job SET status=? WHERE id=?", [status, id]);
    expect(enqueueVerifiedMerge(db, { ...input, now: 3 })).toBe(id);
    expect(jobVersionCurrent(db, old)).toBe(false);
    const current = claimNextJob(db, { now: 3, queues: [JOB_KIND.merge] })!;
    expect(current.id).toBe(old.id);
    expect(current.activationId).toBeGreaterThan(old.activationId);
    expect(jobVersionCurrent(db, old)).toBe(false);
    expect(jobVersionCurrent(db, current)).toBe(true);
    expect(completeJob(db, old, 4)).toBe(false);
    expect(getJob(db, id)).toEqual(current);
    db.close();
  },
);

test.each(["linear", "answer"] as const)(
  "revived %s human turns reset both budgets and preserve per-activation retry baselines and returns",
  (kind) => {
    const db = fixture();
    let now = 2;
    const admit = (key: string, reason: "ci" | "follow_up" | "answer") =>
      restart(db, getWorkItem(db, "item")!, { reason, body: key, jobKey: key, now: now++ })!;
    const key = (turn: number) =>
      kind === "linear" ? `linear-turn:s:${turn}` : `resume:answer:Q${turn}`;
    const reason = kind === "linear" ? "follow_up" : "answer";
    const first = admit(key(1), reason);
    const oldActivation = getJob(db, first)!.activationId;
    saveHumanRetryWindow(db, "item", first, ["first"]);
    recordRebaseReturn(db, { itemId: "item", jobId: first, candidate: "a", reason: "linear" });
    admit("same-head-ci", "ci");
    expect(fixRounds(db, "item")).toBe(1);
    const second = admit(key(2), reason);
    saveHumanRetryWindow(db, "item", second, ["second"]);
    recordRebaseReturn(db, { itemId: "item", jobId: second, candidate: "b", reason: "linear" });
    admit("same-head-ci", "ci");
    expect(fixRounds(db, "item")).toBe(1);
    const owner = getWorkItem(db, "item")!;
    expect(admit(key(1), reason)).toBe(first);
    expect(fixRounds(db, "item")).toBe(0);
    expect(rebaseReturns(db, "item")).toBe(0);
    expect(getJob(db, first)!.activationId).toBeGreaterThan(getJob(db, second)!.activationId);
    expect(latestUserTurn(db, "item")).toBe(getJob(db, first)!.activationId);
    saveHumanRetryWindow(db, "item", first, ["third"]);
    saveHumanRetryWindow(db, "item", first, ["redispatch"]);
    expect(humanRetryBaseline(db, "item")).toEqual(["third"]);
    recordRebaseReturn(db, { itemId: "item", jobId: first, candidate: "c", reason: "linear" });
    recordRebaseReturn(db, { itemId: "item", jobId: first, candidate: "replay", reason: "linear" });
    expect(rebaseReturns(db, "item")).toBe(1);
    expect(listRebaseReturns(db, "item", 0)).toHaveLength(3);
    expect(
      db
        .query(
          "SELECT activation_id FROM closeout_retry_window WHERE job_id=? ORDER BY activation_id",
        )
        .all(first),
    ).toEqual([
      { activation_id: oldActivation },
      { activation_id: getJob(db, first)!.activationId },
    ]);
    expect(restart(db, owner, { reason, body: "replay", jobKey: key(1), now })).toBeNull();
    expect(rebaseReturns(db, "item")).toBe(1);
    admit("same-head-ci", "ci");
    expect(fixRounds(db, "item")).toBe(1);
    db.close();
  },
);

test("repeated non-human rebase returns count once per activation", () => {
  const db = fixture();
  for (const now of [2, 3]) {
    const id = restart(db, getWorkItem(db, "item")!, {
      reason: "conflict",
      body: "rebase",
      jobKey: "conflict",
      now,
    })!;
    for (let replay = 0; replay < 2; replay++)
      recordRebaseReturn(db, { itemId: "item", jobId: id, candidate: "head", reason: "merge" });
    expect(rebaseReturns(db, "item")).toBe(now - 1);
  }
  db.close();
});

test("queue collisions roll back revival and fresh queue settings replace terminal settings", () => {
  const db = fixture();
  const id = enqueueJob(db, { queue: "other", jobKey: "collision", payload: { itemId: "item" } });
  db.run("UPDATE job SET status='done' WHERE id=?", [id]);
  const before = getJob(db, id);
  const item = getWorkItem(db, "item")!;
  expect(() =>
    restart(db, item, { reason: "ci", body: "bad", jobKey: "collision", now: 3 }),
  ).toThrow("different queue");
  expect(getWorkItem(db, "item")).toEqual(item);
  expect(getJob(db, id)).toEqual(before);
  reenqueueJob(db, {
    queue: "other",
    jobKey: "collision",
    payload: { itemId: "item" },
    priority: 2,
    maxAttempts: 6,
    recurringEveryMs: 10,
    runAt: 20,
    now: 4,
  });
  expect(getJob(db, id)).toMatchObject({
    priority: 2,
    maxAttempts: 6,
    recurringEveryMs: 10,
    runAt: 20,
  });
  db.close();
});

test("activation migration preserves existing human windows, returns, and job IDs", () => {
  const db = openDatabase(":memory:");
  const index = migrations.findIndex((m) => m.id === "20261101T0601_job_activation");
  migrate(db, { until: migrations[index - 1]!.id });
  insertQueuedItem(db, { id: "legacy", now: 1 });
  const id = enqueueJob(db, {
    queue: JOB_KIND.resume,
    jobKey: "linear-turn:legacy:1",
    payload: { itemId: "legacy" },
    now: 1,
  });
  db.run(
    "INSERT INTO closeout_retry_window(job_id,item_id,retry_baseline) VALUES (?, 'legacy', '[\"old\"]')",
    [id],
  );
  db.run(
    "INSERT INTO rebase_return(job_id,item_id,candidate,reason) VALUES (?, 'legacy', 'head', 'linear')",
    [id],
  );
  migrate(db);
  expect(getJob(db, id)?.activationId).toBe(id);
  expect(latestUserTurn(db, "legacy")).toBe(id);
  expect(humanRetryBaseline(db, "legacy")).toEqual(["old"]);
  expect(rebaseReturns(db, "legacy")).toBe(1);
  db.run("UPDATE job SET status='done' WHERE id=?", [id]);
  reenqueueJob(db, {
    queue: JOB_KIND.resume,
    jobKey: "linear-turn:legacy:1",
    payload: { itemId: "legacy" },
    now: 2,
  });
  expect(getJob(db, id)!.activationId).toBeGreaterThan(id);
  expect(rebaseReturns(db, "legacy")).toBe(0);
  saveHumanRetryWindow(db, "legacy", id, ["new"]);
  expect(humanRetryBaseline(db, "legacy")).toEqual(["new"]);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  db.close();
});

test("a revived older human row captures a new baseline once and outranks later row IDs", () => {
  const db = fixture();
  const first = enqueueJob(db, {
    queue: JOB_KIND.resume,
    jobKey: "resume:answer:first",
    payload: { itemId: "item", reason: "answer" },
    now: 2,
  });
  saveHumanRetryWindow(db, "item", first, ["first"]);
  const second = enqueueJob(db, {
    queue: JOB_KIND.resume,
    jobKey: "resume:answer:second",
    payload: { itemId: "item", reason: "answer" },
    now: 3,
  });
  saveHumanRetryWindow(db, "item", second, ["second"]);
  db.run("UPDATE job SET status='done' WHERE id=?", [first]);
  reenqueueJob(db, {
    queue: JOB_KIND.resume,
    jobKey: "resume:answer:first",
    payload: { itemId: "item", reason: "answer" },
    now: 4,
  });
  saveHumanRetryWindow(db, "item", first, ["new first"]);
  saveHumanRetryWindow(db, "item", first, ["replayed"]);
  expect(humanRetryBaseline(db, "item")).toEqual(["new first"]);
  db.close();
});
