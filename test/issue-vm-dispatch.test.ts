import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  listItemHolds,
  saveIssueVmSpendSettingsSteps,
  schedulerRunnerSlotsSteps,
  setIssueVmRunnerSteps,
  type Db,
  type IssueVm,
  type IssueVmSpendSettings,
  type Q,
} from "../src/db";
import {
  createFakeIssueVmDriver,
  createIssueVmDrivers,
  createIssueVmSweep,
  issueVmPlacementSteps,
  recordIssueVmSteps,
  type IssueVmDrivers,
} from "../src/issue-vm";
import { createFakeBoat, createFakeBootstrap, createFakeInstaBox } from "../src/provisioning";
import { workspaceDispatchPg } from "./fake-workspace";
import { insertWorkItem, seed, withoutForeignKeys } from "./pglite-fixtures";
import { tempStore } from "./pglite";

const GIB = 1024 ** 3;
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

const runner = (id: string) => (q: Q) =>
  q.orm.insert(q.t.runner).values({
    id,
    workspaceId: "ws",
    ownerUserId: "owner",
    name: id,
    status: "active",
    createdAt: 0,
    lastSeenAt: Date.now(),
  });

async function world() {
  const { db, close } = await tempStore();
  closers.push(close);
  await withoutForeignKeys(db);
  await insertWorkItem(db, "PAS-1");
  await seed(db, runner("runner"));
  return db;
}

function vmHost(db: Db) {
  const size = { vmVcpus: 2, vmMemoryGb: 4, vmDiskGb: 30, reserveVcpus: 4, reserveMemoryGb: 8 };
  return seed(
    db,
    runner("host"),
    (q) =>
      q.orm
        .insert(q.t.runnerHostStatus)
        .values({ runnerId: "host", cpuCount: 16, memoryTotalBytes: 64 * GIB, reportedAt: 0 }),
    (q) =>
      q.orm
        .insert(q.t.vmHost)
        .values({ runnerId: "host", ...size, slotCap: null, updatedAt: 0, updatedBy: "owner" }),
  );
}

const tick = (db: Db, drivers: IssueVmDrivers) =>
  workspaceDispatchPg(db, {
    now: Date.now(),
    issueVm: (q: Q, itemId: string) =>
      issueVmPlacementSteps(q, {
        workspaceId: "ws",
        memberUserId: "owner",
        itemId,
        providers: Object.keys(drivers) as (keyof IssueVmDrivers)[],
        now: Date.now(),
      }),
  });

const vms = (db: Db) =>
  db.run((q) => q.all(q.orm.select().from(q.t.issueVm).orderBy(q.t.issueVm.id))) as Promise<
    IssueVm[]
  >;

const hold = (blocker: string) => [
  { itemId: "PAS-1", reason: "slot" as const, blockers: [blocker] },
];

const setState = (db: Db, state: string) =>
  seed(db, (q) => q.orm.update(q.t.workItem).set({ state }).where(eq(q.t.workItem.id, "PAS-1")));

const cloud = (bootstrap = createFakeBootstrap()) => ({
  boat: createFakeBoat(),
  instaBox: createFakeInstaBox(),
  readToken: () => "fake-key",
  bootstrap: async () => bootstrap,
  vmSizes: () => undefined,
  clock: { now: Date.now, sleep: async () => undefined },
});

test("production startup builds the VM-host, boat and InstaBox drivers", async () => {
  const db = await world();
  expect(Object.keys(createIssueVmDrivers(db, undefined, cloud()))).toEqual([
    "host",
    "boat",
    "instabox",
  ]);
  const host = createFakeIssueVmDriver();
  expect(createIssueVmDrivers(db, { host }, cloud())).toEqual({ host });
});

test("with a VM host on, an item waits for its VM, runs in it and sleeps on awaiting_input", async () => {
  const db = await world();
  await vmHost(db);
  const driver = createFakeIssueVmDriver();
  const drivers = { host: driver };
  const sweep = createIssueVmSweep(db, { drivers });
  const created = hold("Waiting for its issue VM to be created");

  expect(await tick(db, drivers)).toEqual([]);
  expect(await listItemHolds(db)).toEqual(created);
  expect(await tick(db, drivers)).toEqual([]);
  expect(await listItemHolds(db)).toEqual(created);
  const [vm, ...others] = await vms(db);
  expect(others).toEqual([]);
  expect(vm).toMatchObject({ provider: "host", hostRunnerId: "host", state: "creating" });

  await sweep();
  await db.run((q) => setIssueVmRunnerSteps(q, { id: vm!.id, runnerId: "vm-runner" }));
  expect(await tick(db, drivers)).toEqual(["PAS-1"]);
  expect(await listItemHolds(db)).toEqual([]);
  const placed = await db.run((q) => schedulerRunnerSlotsSteps(q, Date.now()));
  expect(placed.map((row) => row.runnerId)).toEqual(["vm-runner"]);

  await setState(db, "running");
  await sweep();
  expect((await vms(db))[0]).toMatchObject({ state: "awake", want: "awake" });

  await setState(db, "awaiting_input");
  await sweep();
  expect((await vms(db))[0]).toMatchObject({ state: "asleep", want: "asleep" });
  expect(driver.calls.map((call) => call.op)).toEqual(["create", "sleep"]);

  await setState(db, "running");
  await sweep();
  expect((await vms(db))[0]).toMatchObject({ state: "awake", want: "awake" });
});

const spendSettings = (db: Db, changes: Partial<IssueVmSpendSettings>) =>
  db.run((q) =>
    saveIssueVmSpendSettingsSteps(q, {
      workspaceId: "ws",
      changes,
      defaultLimitUsd: 50,
      updatedBy: "owner",
      now: Date.now(),
    }),
  );

test("a cloud provider without a snapshot name is not used, so the item runs on a normal runner", async () => {
  const db = await world();
  await spendSettings(db, { boatHourlyUsd: 1, instaboxHourlyUsd: 1, boatSnapshot: "paws-base" });
  const drivers = { host: createFakeIssueVmDriver(), instabox: createFakeIssueVmDriver() };
  expect(await tick(db, drivers)).toEqual(["PAS-1"]);
  expect(await vms(db)).toEqual([]);
});

test("with a boat key, hourly price and snapshot, an item creates a boat issue VM and runs on it", async () => {
  const db = await world();
  await seed(
    db,
    (q) =>
      q.orm
        .insert(q.t.workspaceUser)
        .values({ id: "owner", linearUserId: "owner", name: "Owner", email: "o@example.invalid" }),
    (q) =>
      q.orm.insert(q.t.workspaceMember).values({
        workspaceId: "ws",
        userId: "owner",
        role: "member",
        source: "linear",
        active: 1,
        checkedAt: 0,
      }),
  );
  await spendSettings(db, {
    boatHourlyUsd: 1,
    instaboxHourlyUsd: 1,
    boatSnapshot: "paws-base",
    instaboxSnapshot: "snap",
  });
  const options = cloud();
  const drivers = createIssueVmDrivers(db, undefined, options);
  const sweep = createIssueVmSweep(db, { drivers });
  expect(await tick(db, drivers)).toEqual([]);
  expect(await listItemHolds(db)).toEqual(hold("Waiting for its issue VM to be created"));
  await sweep();
  const [vm, ...others] = await vms(db);
  expect(others).toEqual([]);
  const name = `paws-${vm!.id.toLowerCase()}`;
  expect(vm).toMatchObject({ provider: "boat", state: "awake", runnerId: `runner-${name}` });
  expect(options.boat.sandboxes.get(name)).toMatchObject({ from: "paws-base", state: "ready" });
  expect(vm!.providerVmId).toBe(options.boat.sandboxes.get(name)!.id);
  const enrollments = await db.run((q) => q.all(q.orm.select().from(q.t.runnerEnrollment)));
  expect(enrollments.map((row) => [row.issueVmId, row.userId])).toEqual([[vm!.id, "owner"]]);

  expect(await tick(db, drivers)).toEqual(["PAS-1"]);
  const placed = await db.run((q) => schedulerRunnerSlotsSteps(q, Date.now()));
  expect(placed.map((row) => row.runnerId)).toEqual([`runner-${name}`]);
});

test("an item whose owner is over their issue VM budget waits with the reason", async () => {
  const db = await world();
  await vmHost(db);
  await db.run(function* (q) {
    for (const itemId of ["PAS-8", "PAS-9"])
      yield* recordIssueVmSteps(q, {
        workspaceId: "ws",
        itemId,
        memberUserId: "owner",
        provider: "host",
        hostRunnerId: "host",
        now: Date.now(),
      });
  });
  expect(await tick(db, { host: createFakeIssueVmDriver() })).toEqual([]);
  expect(await listItemHolds(db)).toEqual(
    hold("Waiting for an issue VM: its owner already has 2 of 2"),
  );
  expect((await vms(db)).map((vm) => vm.itemId)).toEqual(["PAS-8", "PAS-9"]);
});

test("with every configured VM host paused or offline, the item waits instead of running elsewhere", async () => {
  const db = await world();
  await vmHost(db);
  const drivers = { host: createFakeIssueVmDriver() };
  for (const set of [{ status: "paused" }, { status: "active", lastSeenAt: 0 }]) {
    await seed(db, (q) => q.orm.update(q.t.runner).set(set).where(eq(q.t.runner.id, "host")));
    expect(await tick(db, drivers)).toEqual([]);
    expect(await listItemHolds(db)).toEqual(hold("Waiting for a VM host to come online"));
  }
  expect(await vms(db)).toEqual([]);
});
