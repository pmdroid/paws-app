import { afterEach, expect, test } from "bun:test";
import { moveIssueVmSteps, type Db, type IssueVm } from "../src/db";
import {
  createFakeIssueVmDriver,
  createIssueVmLifecycle,
  requestIssueVmAsleepSteps,
  requestIssueVmAwakeSteps,
  type FakeIssueVmDriver,
  type IssueVmLifecycleOptions,
} from "../src/issue-vm";
import { setJournalSink } from "../src/journal";
import { describePglite, withoutForeignKeys, type PgliteTestDb } from "./pglite-fixtures";

const NOW = 1_000 * 86_400_000;

const opened: PgliteTestDb[] = [];
const restores: (() => void)[] = [];
afterEach(async () => {
  for (const restore of restores.splice(0)) restore();
  for (const handle of opened.splice(0)) await handle.close();
});

type World = { db: Db; driver: FakeIssueVmDriver; clock: { t: number }; lines: string[] };

async function world(connect: () => Promise<PgliteTestDb>): Promise<World> {
  const handle = await connect();
  opened.push(handle);
  await withoutForeignKeys(handle.db);
  const lines: string[] = [];
  restores.push(setJournalSink((line) => lines.push(line)));
  return { db: handle.db, driver: createFakeIssueVmDriver(), clock: { t: NOW }, lines };
}

function awake({ db, clock }: World) {
  return db.transaction((q) =>
    requestIssueVmAwakeSteps(q, {
      workspaceId: "acme",
      itemId: "item-1",
      memberUserId: "ada",
      provider: "host",
      now: clock.t,
    }),
  );
}

const asleep = ({ db }: World) =>
  db.transaction((q) => requestIssueVmAsleepSteps(q, { itemId: "item-1" }));

function sweep(w: World, deadlineMs?: IssueVmLifecycleOptions["deadlineMs"]) {
  w.clock.t += 1;
  return createIssueVmLifecycle(w.db, {
    drivers: { host: w.driver },
    now: () => w.clock.t,
    deadlineMs,
  }).sweep();
}

async function row(db: Db): Promise<IssueVm> {
  const [found] = await db.run((q) => q.all(q.orm.select().from(q.t.issueVm)));
  return found as IssueVm;
}

const ops = (w: World) => w.driver.calls.map((call) => call.op);

async function awakeVm(w: World) {
  await awake(w);
  await sweep(w);
  expect(await row(w.db)).toMatchObject({ state: "awake", operation: null });
}

async function asleepVm(w: World) {
  await awakeVm(w);
  await asleep(w);
  await sweep(w);
  expect(await row(w.db)).toMatchObject({ state: "asleep", operation: null });
}

describePglite((connect) => {
  test("creates, sleeps and wakes the VM, passing each call the record's generation", async () => {
    const w = await world(connect);
    expect(await awake(w)).toMatchObject({ ok: true, ready: false, vm: { state: "creating" } });
    await sweep(w);
    expect(await awake(w)).toMatchObject({ ok: true, ready: true, vm: { state: "awake" } });
    expect(await asleep(w)).toBe(true);
    await sweep(w);
    expect(w.driver.vms.get((await row(w.db)).id)).toBe("off");
    await awake(w);
    await sweep(w);
    expect(await row(w.db)).toMatchObject({ state: "awake", want: "awake", generation: 6 });
    expect(w.driver.calls.map(({ op, generation }) => [op, generation])).toEqual([
      ["create", 1],
      ["sleep", 3],
      ["wake", 5],
    ]);
    const awakes = await w.db.run((q) =>
      q.all(q.orm.select().from(q.t.issueVmAwake).orderBy(q.t.issueVmAwake.startedAt)),
    );
    expect(awakes.map((spell) => spell.endedAt === null)).toEqual([false, true]);
  });

  test("a result after the deadline is ignored and the record becomes unknown", async () => {
    const w = await world(connect);
    const { vm } = (await awake(w)) as { vm: IssueVm };
    w.driver.aroundNext("create", async (run) => {
      w.clock.t += 16 * 60_000;
      return run();
    });
    w.driver.aroundNext("reconcile", () => new Promise(() => undefined));
    await sweep(w, { reconcile: 10 });
    expect(await row(w.db)).toMatchObject({
      id: vm.id,
      state: "unknown",
      operation: "create",
      failure: "The VM was not created before its deadline",
    });
    expect(
      w.lines.some(
        (line) => line.includes("issue_vm_result_ignored") && line.includes("reason=late"),
      ),
    ).toBe(true);
  });

  test("a call that misses its deadline is aborted, and the sweep reconciles it to the provider's state", async () => {
    const w = await world(connect);
    await awakeVm(w);
    await asleep(w);
    let signal: AbortSignal | null = null;
    w.driver.aroundNext("sleep", (_run, given) => {
      signal = given;
      return new Promise(() => undefined);
    });
    w.driver.aroundNext("reconcile", () => new Promise(() => undefined));
    await sweep(w, { sleep: 20, reconcile: 10 });
    expect(signal!.aborted).toBe(true);
    expect(await row(w.db)).toMatchObject({ state: "unknown", operation: "sleep" });
    const { id } = await row(w.db);
    w.driver.vms.set(id, "off");
    await sweep(w);
    expect(await row(w.db)).toMatchObject({ state: "asleep", operation: null, failure: null });
    expect(ops(w).slice(-3)).toEqual(["sleep", "reconcile", "reconcile"]);
  });

  test("a VM awake after its wake deadline passed reconciles to failed", async () => {
    const w = await world(connect);
    await asleepVm(w);
    await awake(w);
    w.driver.aroundNext("wake", async (run) => {
      w.clock.t += 3 * 60_000;
      return run();
    });
    await sweep(w);
    expect(w.driver.vms.get((await row(w.db)).id)).toBe("on");
    expect(await row(w.db)).toMatchObject({ state: "failed", operation: null });
    expect((await row(w.db)).failure).toContain("wake deadline");
    expect(ops(w).slice(-2)).toEqual(["wake", "reconcile"]);
  });

  test("a result for an older generation is ignored", async () => {
    const w = await world(connect);
    await awakeVm(w);
    await asleep(w);
    let release = () => {};
    const open = new Promise<void>((resolve) => (release = resolve));
    let reached = () => {};
    const atGate = new Promise<void>((resolve) => (reached = resolve));
    w.driver.aroundNext("sleep", async (run) => (reached(), await open, run()));
    const running = sweep(w);
    await atGate;
    const newer = (await row(w.db)).generation + 5;
    await w.db.run((q) => q.exec(q.orm.update(q.t.issueVm).set({ generation: newer })));
    release();
    await running;
    expect(await row(w.db)).toMatchObject({
      state: "awake",
      operation: "sleep",
      generation: newer,
    });
    expect(
      w.lines.some(
        (line) => line.includes("issue_vm_result_ignored") && line.includes("reason=stale"),
      ),
    ).toBe(true);
  });

  test("a failed record is not advanced", async () => {
    const w = await world(connect);
    await asleepVm(w);
    w.driver.vms.clear();
    await awake(w);
    await sweep(w);
    const failed = await row(w.db);
    expect(failed).toMatchObject({ state: "failed" });
    const calls = w.driver.calls.length;
    expect(await awake(w)).toMatchObject({ ok: false, reason: "failed" });
    expect(await asleep(w)).toBe(false);
    await sweep(w);
    const set = { state: "awake" as const };
    const now = w.clock.t;
    const moved = await w.db.run((q) =>
      moveIssueVmSteps(q, { id: failed.id, generation: failed.generation, set, now }),
    );
    expect(moved).toBe(false);
    expect(w.driver.calls.length).toBe(calls);
    expect(await row(w.db)).toEqual(failed);
  });
});
