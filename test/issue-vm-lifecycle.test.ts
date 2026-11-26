import { afterEach, expect, test } from "bun:test";
import { claimNextJob, completeJob, syncSteps, type Db, type IssueVm } from "../src/db";
import {
  createFakeIssueVmDriver,
  createIssueVmLifecycleHandler,
  ISSUE_VM_FIND_MS,
  ISSUE_VM_LIFECYCLE_QUEUE,
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

function gate() {
  let release = () => {};
  let reached = () => {};
  const atGate = new Promise<void>((resolve) => (reached = resolve));
  const open = new Promise<void>((resolve) => (release = resolve));
  const around = async (run: () => unknown) => {
    reached();
    await open;
    return run();
  };
  return { atGate, release, around };
}

const crash = (when: "before" | "after") => async (run: () => unknown) => {
  if (when === "after") run();
  throw new Error(`crashed ${when} the provider call`);
};

const lateBy = (w: World, deadline: number) => async (run: () => unknown) => {
  w.clock.t = deadline + 1;
  return run();
};

async function sleepThenWaking(w: World) {
  await awake(w);
  await drain(w);
  await asleep(w);
  await drain(w);
  await awake(w);
  w.driver.aroundNext("wake", crash("before"));
  await drain(w, 1);
  const [waking] = await live(w.db);
  expect(waking).toMatchObject({ state: "waking" });
  return waking!;
}

async function reconcile(w: World) {
  expect(await w.db.transaction((q) => armUnsettledIssueVmsSteps(q, w.clock.t))).toBe(true);
  await drain(w);
}

const ops = (w: World) => w.driver.calls.map((call) => call.op);
const power = (w: World) => [...w.driver.vms.values()].map((vm) => vm.power);

describePglite((connect) => {
  test("creates the VM on first dispatch, sleeps it when the item waits and wakes it again", async () => {
    const w = await world(connect);
    expect(await awake(w)).toMatchObject({ ok: true, ready: false, vm: { state: "creating" } });
    await drain(w);
    expect(await awake(w)).toMatchObject({ ok: true, ready: true, vm: { state: "awake" } });
    expect(await asleep(w)).toBe(true);
    await drain(w);
    expect(await live(w.db)).toMatchObject([{ state: "asleep", want: "asleep" }]);
    expect(power(w)).toEqual(["off"]);
    await awake(w);
    await drain(w);
    expect(await live(w.db)).toMatchObject([{ state: "awake", providerRef: "fake-1" }]);
    expect(ops(w)).toEqual(["create", "sleep", "wake"]);
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
    expect(await rows(w.db)).toHaveLength(2);
  });

  test("a crash at every provider step leaves one VM and none awake by mistake", async () => {
    for (const op of ["create", "sleep", "wake"] as const)
      for (const when of ["before", "after"] as const) {
        const w = await world(connect);
        w.driver.aroundNext(op, crash(when));
        await awake(w);
        await drain(w);
        await asleep(w);
        await drain(w);
        expect(await live(w.db)).toMatchObject([{ state: "asleep" }]);
        expect(power(w)).toEqual(["off"]);
        await awake(w);
        await drain(w);
        expect(await rows(w.db)).toMatchObject([{ state: "awake", want: "awake" }]);
        expect(power(w)).toEqual(["on"]);
      }
  });

  test("a sleep asked for while the VM is created is kept by a later awake request", async () => {
    const w = await world(connect);
    await awake(w);
    const held = gate();
    w.driver.aroundNext("create", held.around);
    const running = drain(w);
    await held.atGate;
    await asleep(w);
    expect(await awake(w)).toMatchObject({ ok: true, ready: false });
    held.release();
    await running;
    expect(await live(w.db)).toMatchObject([{ state: "asleep" }]);
    await awake(w);
    await drain(w);
    expect(await live(w.db)).toMatchObject([{ state: "awake" }]);
    expect(ops(w)).toEqual(["create", "sleep", "wake"]);
  });

  test("a create result after its deadline is ignored and never marks the VM awake", async () => {
    const w = await world(connect);
    const { vm } = (await awake(w)) as { vm: IssueVm };
    w.driver.aroundNext("create", lateBy(w, vm.deadlineAt!));
    await drain(w);
    expect(await rows(w.db)).toMatchObject([
      { state: "unknown", providerRef: null, failure: "The VM did not start before its deadline" },
    ]);
  });

  test("a create the provider does not show yet stays unknown, and is fully slept when it appears", async () => {
    const w = await world(connect);
    const { vm } = (await awake(w)) as { vm: IssueVm };
    w.driver.aroundNext("create", async () => {
      w.clock.t = vm.deadlineAt! + 1;
    });
    await drain(w);
    w.clock.t += ISSUE_VM_FIND_MS + 1_000;
    await reconcile(w);
    await awake(w);
    await drain(w);
    expect(await rows(w.db)).toMatchObject([{ state: "unknown" }]);
    w.driver.vms.set(vm.id, { ref: "late", power: "on" });
    await reconcile(w);
    expect(await rows(w.db)).toMatchObject([{ state: "awake", providerRef: "late" }]);
    expect(ops(w).slice(-3)).toEqual(["find", "sleep", "wake"]);
    expect(w.driver.vms.size).toBe(1);
  });

  test("a wake result after its deadline is ignored and keeps the deadline", async () => {
    const w = await world(connect);
    const waking = await sleepThenWaking(w);
    w.driver.aroundNext("wake", lateBy(w, waking.deadlineAt!));
    await drain(w);
    expect(await rows(w.db)).toMatchObject([
      {
        state: "unknown",
        deadlineAt: waking.deadlineAt,
        failure: "The VM did not wake before its deadline",
      },
    ]);
    w.clock.t += ISSUE_VM_FIND_MS + 1_000;
    await reconcile(w);
    expect(await rows(w.db)).toMatchObject([{ state: "awake" }]);
    expect(ops(w).slice(-3)).toEqual(["find", "sleep", "wake"]);
  });

  test("a call that never answers is aborted at the deadline and reconciled from the provider", async () => {
    const w = await world(connect);
    const waking = await sleepThenWaking(w);
    let signal: AbortSignal | null = null;
    w.driver.aroundNext("wake", (_run, given) => {
      signal = given;
      return new Promise(() => undefined);
    });
    w.clock.t = waking.deadlineAt! - 20;
    await drain(w);
    expect(signal!.aborted).toBe(true);
    expect(await awake(w)).toMatchObject({ ok: true, ready: false, vm: { state: "unknown" } });
    await drain(w);
    expect(await rows(w.db)).toMatchObject([{ state: "unknown" }]);
    expect(ops(w).at(-1)).toBe("wake");
    w.clock.t += ISSUE_VM_FIND_MS + 1_000;
    await reconcile(w);
    expect(await rows(w.db)).toMatchObject([{ state: "awake", want: "awake" }]);
    expect(ops(w).slice(-2)).toEqual(["find", "wake"]);
  });

  test("a result for an older generation is ignored and the current one is asked again", async () => {
    const w = await world(connect);
    await awake(w);
    await drain(w);
    await asleep(w);
    const held = gate();
    w.driver.aroundNext("sleep", held.around);
    const running = drain(w);
    await held.atGate;
    const [sleeping] = await live(w.db);
    const newer = sleeping!.generation + 5;
    await w.db.run((q) => q.exec(q.orm.update(q.t.issueVm).set({ generation: newer })));
    held.release();
    await running;
    const sleeps = w.driver.calls.filter((call) => call.op === "sleep");
    expect(sleeps.map((call) => call.generation)).toEqual([sleeping!.generation, newer]);
    expect(await live(w.db)).toMatchObject([{ state: "asleep", generation: newer + 1 }]);
  });

  test("a VM gone after sleeping fails, and the next dispatch creates a new one", async () => {
    const w = await world(connect);
    await awake(w);
    await drain(w);
    await asleep(w);
    await drain(w);
    w.driver.vms.clear();
    await awake(w);
    await drain(w);
    expect((await rows(w.db))[0]!.failure).toContain("no longer lists");
    await awake(w);
    await drain(w);
    expect(await rows(w.db)).toMatchObject([{ state: "failed" }, { state: "awake" }]);
  });
});
