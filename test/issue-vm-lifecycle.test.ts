import { afterEach, expect, test } from "bun:test";
import { claimNextJob, completeJob, syncSteps, type Db, type IssueVm } from "../src/db";
import {
  createFakeIssueVmDriver,
  createIssueVmLifecycleHandler,
  ISSUE_VM_LIFECYCLE_QUEUE,
  ISSUE_VM_WAKE_MS,
  armUnsettledIssueVmsSteps,
  requestIssueVmAsleepSteps,
  requestIssueVmAwakeSteps,
  type FakeIssueVmDriver,
} from "../src/issue-vm";
import { describePglite, withoutForeignKeys, type PgliteTestDb } from "./pglite-fixtures";

const NOW = 1_000 * 86_400_000;

const opened: PgliteTestDb[] = [];
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close();
});

type World = { db: Db; driver: FakeIssueVmDriver; clock: { t: number } };

async function world(connect: () => Promise<PgliteTestDb>): Promise<World> {
  const handle = await connect();
  opened.push(handle);
  await withoutForeignKeys(handle.db);
  return { db: handle.db, driver: createFakeIssueVmDriver(), clock: { t: NOW } };
}

function awake({ db, clock }: World, itemId = "item-1", member = "ada") {
  return db.transaction((q) =>
    requestIssueVmAwakeSteps(q, {
      workspaceId: "acme",
      itemId,
      memberUserId: member,
      provider: "host",
      now: clock.t,
    }),
  );
}

function asleep({ db, clock }: World, itemId = "item-1") {
  return db.transaction((q) => requestIssueVmAsleepSteps(q, { itemId, now: clock.t }));
}

const context = {
  signal: new AbortController().signal,
  isCurrent: async () => true,
  isCurrentSteps: () => syncSteps(() => true),
  extendLease: async () => true,
};

async function drain({ db, driver, clock }: World, limit = 40) {
  const handler = createIssueVmLifecycleHandler(db, {
    drivers: { host: driver },
    now: () => clock.t,
    retryMs: 0,
  });
  for (let count = 0; count < limit; count += 1) {
    clock.t += 1;
    const job = await claimNextJob(db, {
      queues: [ISSUE_VM_LIFECYCLE_QUEUE],
      now: clock.t,
      workerId: "test",
      leaseMs: 60_000,
    });
    if (job === null) return;
    await handler(job, context);
    await completeJob(db, job, clock.t);
  }
  if (limit === 40) throw new Error("the lifecycle job did not settle");
}

async function rows(db: Db): Promise<IssueVm[]> {
  const found = await db.run((q) =>
    q.all(q.orm.select().from(q.t.issueVm).orderBy(q.t.issueVm.createdAt, q.t.issueVm.id)),
  );
  return found as IssueVm[];
}

async function live(db: Db): Promise<IssueVm[]> {
  return (await rows(db)).filter((row) => !["deleted", "failed"].includes(row.state));
}

describePglite((connect) => {
  test("creates the VM on first dispatch, sleeps it when the item waits and wakes it again", async () => {
    const w = await world(connect);
    expect(await awake(w)).toMatchObject({ ok: true, ready: false, vm: { state: "creating" } });
    await drain(w);
    expect(await awake(w)).toMatchObject({ ok: true, ready: true, vm: { state: "awake" } });

    expect(await asleep(w)).toBe(true);
    await drain(w);
    expect(await live(w.db)).toMatchObject([{ state: "asleep", want: "asleep" }]);
    expect([...w.driver.vms.values()]).toEqual([{ ref: "fake-1", power: "off" }]);

    expect(await awake(w)).toMatchObject({ ok: true, ready: false });
    await drain(w);
    expect(await live(w.db)).toMatchObject([{ state: "awake", providerRef: "fake-1" }]);
    expect(w.driver.calls.map((call) => call.op)).toEqual(["create", "sleep", "wake"]);
    const awakes = await w.db.run((q) =>
      q.all(q.orm.select().from(q.t.issueVmAwake).orderBy(q.t.issueVmAwake.startedAt)),
    );
    expect(awakes.map((row) => row.endedAt === null)).toEqual([false, true]);
  });

  test("an item over its member's budget waits with the reason and creates nothing", async () => {
    const w = await world(connect);
    await awake(w, "item-1");
    await awake(w, "item-2");
    expect(await awake(w, "item-3")).toEqual({
      ok: false,
      refusal: { ok: false, reason: "member_limit", limit: 2, inUse: 2 },
    });
    expect((await rows(w.db)).map((row) => row.itemId).sort()).toEqual(["item-1", "item-2"]);
    expect(await awake(w, "item-3", "grace")).toMatchObject({ ok: true });
  });

  test("a VM told to sleep finishes sleeping before it wakes", async () => {
    const w = await world(connect);
    await awake(w);
    await drain(w);
    await asleep(w);
    w.driver.failNext("sleep", "before");
    await drain(w, 1);
    expect(await live(w.db)).toMatchObject([{ state: "sleeping" }]);
    await awake(w);
    await drain(w);
    expect(await live(w.db)).toMatchObject([{ state: "awake" }]);
    expect(w.driver.calls.map((call) => call.op)).toEqual(["create", "sleep", "sleep", "wake"]);
  });

  test("a crash at every provider step leaves one VM and none awake by mistake", async () => {
    const ops = ["create", "sleep", "wake"] as const;
    for (const op of ops)
      for (const when of ["before", "after"] as const) {
        const w = await world(connect);
        w.driver.failNext(op, when);
        await awake(w);
        await drain(w);
        await asleep(w);
        await drain(w);
        const slept = await live(w.db);
        expect(slept).toMatchObject([{ state: "asleep" }]);
        expect([...w.driver.vms.values()].map((vm) => vm.power)).toEqual(["off"]);
        await awake(w);
        await drain(w);
        expect(await live(w.db)).toMatchObject([{ state: "awake", want: "awake" }]);
        expect([...w.driver.vms.values()].map((vm) => vm.power)).toEqual(["on"]);
        expect((await rows(w.db)).length).toBe(1);
      }
  });

  test("a crashed job is picked up again by the sweep", async () => {
    const w = await world(connect);
    await awake(w);
    await w.db.run((q) => q.exec(q.orm.delete(q.t.job)));
    expect(await w.db.transaction((q) => armUnsettledIssueVmsSteps(q, w.clock.t))).toBe(true);
    await drain(w);
    expect(await live(w.db)).toMatchObject([{ state: "awake" }]);
  });

  test("a wake past its deadline replaces the VM instead of counting it awake", async () => {
    const w = await world(connect);
    await awake(w);
    await drain(w);
    await asleep(w);
    await drain(w);
    await awake(w);
    w.driver.failNext("wake", "before", new Error("resume timed out"));
    await drain(w, 1);
    expect(await live(w.db)).toMatchObject([{ state: "waking" }]);
    w.clock.t += ISSUE_VM_WAKE_MS + 1;
    await drain(w);
    const [old, next] = await rows(w.db);
    expect(old).toMatchObject({
      state: "failed",
      failure: "The VM did not wake before its deadline",
    });
    expect(next).toMatchObject({ state: "awake", replaces: old!.id, itemId: "item-1" });
    expect(w.driver.calls.map((call) => call.op)).toEqual([
      "create",
      "sleep",
      "wake",
      "remove",
      "create",
    ]);
    expect(w.driver.vms.size).toBe(1);
  });

  test("a VM gone after sleeping is lost and replaced on the next dispatch", async () => {
    const w = await world(connect);
    await awake(w);
    await drain(w);
    await asleep(w);
    await drain(w);
    const [first] = await live(w.db);
    w.driver.vms.delete(first!.id);
    await awake(w);
    await drain(w);
    const [old, next] = await rows(w.db);
    expect(old).toMatchObject({ state: "failed" });
    expect(old!.failure).toContain("no longer lists");
    expect(next).toMatchObject({ state: "awake", replaces: old!.id });
    expect([...w.driver.vms.values()].map((vm) => vm.power)).toEqual(["on"]);
  });
});
