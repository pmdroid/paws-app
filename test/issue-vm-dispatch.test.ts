import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  listItemHolds,
  saveIssueVmSpendSettingsSteps,
  schedulerRunnerSlotsSteps,
  setIssueVmRunnerSteps,
  type Db,
  type IssueVm,
  type IssueVmProvider,
  type Q,
} from "../src/db";
import {
  createFakeIssueVmDriver,
  createIssueVmSweep,
  issueVmPlacementSteps,
} from "../src/issue-vm";
import { workspaceDispatchPg } from "./fake-workspace";
import { seed, withoutForeignKeys } from "./pglite-fixtures";
import { tempStore } from "./pglite";

const GIB = 1024 ** 3;
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function world() {
  const { db, close } = await tempStore();
  closers.push(close);
  await withoutForeignKeys(db);
  const now = Date.now();
  await seed(
    db,
    (q) =>
      q.orm.insert(q.t.workItem).values({
        id: "PAS-1",
        delegationId: "delegation",
        linearIssueId: "issue-PAS-1",
        linearIdentifier: "PAS-1",
        title: "PAS-1",
        state: "queued",
        branchName: "paws/PAS-1",
        position: 0,
        createdAt: 0,
      }),
    (q) =>
      q.orm.insert(q.t.runner).values({
        id: "runner",
        workspaceId: "ws",
        ownerUserId: "owner",
        name: "Runner",
        status: "active",
        createdAt: 0,
        lastSeenAt: now,
      }),
    (q) =>
      q.orm.insert(q.t.runnerWork).values({
        runId: "run",
        runnerId: "runner",
        workspaceId: "ws",
        generation: 1,
        runnerFence: 0,
        commandId: "command",
        leaseUntil: now + 600_000,
        lastSequence: 0,
      }),
  );
  return db;
}

function vmHost(db: Db) {
  return seed(
    db,
    (q) =>
      q.orm.insert(q.t.runner).values({
        id: "host",
        workspaceId: "ws",
        ownerUserId: "owner",
        name: "Host",
        status: "active",
        createdAt: 0,
        lastSeenAt: Date.now(),
      }),
    (q) =>
      q.orm
        .insert(q.t.runnerHostStatus)
        .values({ runnerId: "host", cpuCount: 16, memoryTotalBytes: 64 * GIB, reportedAt: 0 }),
    (q) =>
      q.orm.insert(q.t.vmHost).values({
        runnerId: "host",
        vmVcpus: 2,
        vmMemoryGb: 4,
        vmDiskGb: 30,
        reserveVcpus: 4,
        reserveMemoryGb: 8,
        slotCap: null,
        updatedAt: 0,
        updatedBy: "owner",
      }),
  );
}

const tick = (db: Db, providers: IssueVmProvider[]) =>
  workspaceDispatchPg(db, {
    now: Date.now(),
    issueVm: (q: Q, itemId: string) =>
      issueVmPlacementSteps(q, {
        workspaceId: "ws",
        memberUserId: "owner",
        itemId,
        providers,
        now: Date.now(),
      }),
  });

const vms = (db: Db) =>
  db.run((q) => q.all(q.orm.select().from(q.t.issueVm))) as Promise<IssueVm[]>;

const setState = (db: Db, state: string) =>
  seed(db, (q) => q.orm.update(q.t.workItem).set({ state }).where(eq(q.t.workItem.id, "PAS-1")));

test("with a VM host on, an item waits for its VM, runs on it and sleeps on awaiting_input", async () => {
  const db = await world();
  await vmHost(db);
  const driver = createFakeIssueVmDriver();
  const sweep = createIssueVmSweep(db, { drivers: { host: driver } });

  expect(await tick(db, ["host"])).toEqual([]);
  expect(await listItemHolds(db)).toEqual([
    { itemId: "PAS-1", reason: "slot", blockers: ["Waiting for its issue VM to be created"] },
  ]);
  const [created] = await vms(db);
  expect(created).toMatchObject({ provider: "host", hostRunnerId: "host", state: "creating" });

  await sweep();
  await db.run((q) => setIssueVmRunnerSteps(q, { id: created!.id, runnerId: "vm-runner" }));
  expect(await tick(db, ["host"])).toEqual(["PAS-1"]);
  expect(await listItemHolds(db)).toEqual([]);
  expect(
    (await db.run((q) => schedulerRunnerSlotsSteps(q, Date.now()))).map((row) => row.runnerId),
  ).toEqual(["vm-runner"]);

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

test("with no usable provider the item runs on a normal runner", async () => {
  const db = await world();
  await seed(db, (q) => q.orm.delete(q.t.runnerWork));
  expect(await tick(db, ["host", "boat"])).toEqual(["PAS-1"]);
  expect(await vms(db)).toEqual([]);
});

test("an item over the issue VM spend limit waits with the reason", async () => {
  const db = await world();
  const now = Date.now();
  await seed(
    db,
    (q) =>
      q.orm.insert(q.t.issueVm).values({
        id: "old",
        workspaceId: "ws",
        itemId: "PAS-0",
        memberUserId: "owner",
        provider: "boat",
        state: "deleted",
        createdAt: now - 20_000,
        stateAt: now - 1_000,
      }),
    (q) =>
      q.orm.insert(q.t.issueVmAwake).values({
        id: "awake",
        issueVmId: "old",
        startedAt: now - 11_000,
        endedAt: now - 1_000,
        hourlyUsd: 36_000,
      }),
  );
  await db.run((q) =>
    saveIssueVmSpendSettingsSteps(q, {
      workspaceId: "ws",
      changes: { boatHourlyUsd: 1, monthlyLimitUsd: 50 },
      defaultLimitUsd: 50,
      updatedBy: "owner",
      now,
    }),
  );
  expect(await tick(db, ["boat"])).toEqual([]);
  expect(await listItemHolds(db)).toEqual([
    {
      itemId: "PAS-1",
      reason: "slot",
      blockers: [
        "Waiting for an issue VM: Monthly issue VM spend limit reached ($100.00 of $50.00)",
      ],
    },
  ]);
  expect((await vms(db)).map((vm) => vm.id)).toEqual(["old"]);
});
