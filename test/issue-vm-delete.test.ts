import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  failingIssueVmDeletesSteps,
  setIssueVmRunnerSteps,
  type Db,
  type IssueVm,
  type Q,
} from "../src/db";
import {
  createBoatIssueVmDriver,
  createFakeIssueVmDriver,
  createIssueVmSweep,
  issueVmPlacementSteps,
  ISSUE_VM_DELETE_RETRY_MS,
  type BoatIssueVms,
  type FakeIssueVmDriver,
} from "../src/issue-vm";
import { insertWorkItem, seed, withoutForeignKeys } from "./pglite-fixtures";
import { tempStore } from "./pglite";
import { seedSettings } from "./saved-settings";

const GIB = 1024 ** 3;
const DAY = 86_400_000;
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

const runner = (id: string, lastSeenAt: () => number) => (q: Q) =>
  q.orm.insert(q.t.runner).values({
    id,
    workspaceId: "ws",
    ownerUserId: "owner",
    name: id,
    status: "active",
    createdAt: 0,
    lastSeenAt: lastSeenAt(),
  });

type World = {
  db: Db;
  clock: { t: number };
  driver: FakeIssueVmDriver;
  sweep: () => Promise<void>;
};

async function world(driver = createFakeIssueVmDriver()): Promise<World> {
  const { db, close } = await tempStore();
  closers.push(close);
  await withoutForeignKeys(db);
  await insertWorkItem(db, "PAS-1");
  const clock = { t: Date.now() };
  const size = { vmVcpus: 2, vmMemoryGb: 4, vmDiskGb: 30, reserveVcpus: 4, reserveMemoryGb: 8 };
  await seed(
    db,
    runner("host", () => clock.t),
    (q) =>
      q.orm
        .insert(q.t.runnerHostStatus)
        .values({ runnerId: "host", cpuCount: 16, memoryTotalBytes: 64 * GIB, reportedAt: 0 }),
    (q) =>
      q.orm
        .insert(q.t.vmHost)
        .values({ runnerId: "host", ...size, slotCap: null, updatedAt: 0, updatedBy: "owner" }),
  );
  const sweep = createIssueVmSweep(db, { drivers: { host: driver }, now: () => clock.t });
  return { db, clock, driver, sweep };
}

const place = ({ db, clock }: World) =>
  db.transaction((q) =>
    issueVmPlacementSteps(q, {
      workspaceId: "ws",
      memberUserId: "owner",
      itemId: "PAS-1",
      providers: ["host"],
      now: clock.t,
    }),
  );

const vms = (db: Db) =>
  db.run((q) => q.all(q.orm.select().from(q.t.issueVm).orderBy(q.t.issueVm.id))) as Promise<
    IssueVm[]
  >;

const setState = (db: Db, state: string) =>
  seed(db, (q) => q.orm.update(q.t.workItem).set({ state }).where(eq(q.t.workItem.id, "PAS-1")));

const ops = (w: World) => w.driver.calls.map((call) => `${call.op}:${call.name}`);

async function awakeVm(w: World) {
  await setState(w.db, "running");
  await place(w);
  await w.sweep();
  const [vm] = await vms(w.db);
  await w.db.run((q) => setIssueVmRunnerSteps(q, { id: vm!.id, runnerId: "vm-runner" }));
  expect(vm).toMatchObject({ state: "awake" });
  return vm!;
}

test("a merged item's VM is deleted without sleeping first, and only that VM", async () => {
  const w = await world();
  w.driver.vms.set("stray", "on");
  const vm = await awakeVm(w);
  await seed(
    w.db,
    runner("vm-runner", () => w.clock.t),
  );

  await setState(w.db, "merged");
  w.clock.t += 1;
  await w.sweep();

  const [row] = await vms(w.db);
  expect(row).toMatchObject({ id: vm.id, state: "deleted", deletedAt: w.clock.t, failure: null });
  expect(ops(w)).toEqual([`create:${vm.id}`, `delete:${vm.id}`]);
  expect([...w.driver.vms.keys()]).toEqual(["stray"]);
  const [vmRunner] = await w.db.run((q) =>
    q.all(q.orm.select().from(q.t.runner).where(eq(q.t.runner.id, "vm-runner"))),
  );
  expect(vmRunner).toMatchObject({ status: "revoked" });
  const awake = await w.db.run((q) => q.all(q.orm.select().from(q.t.issueVmAwake)));
  expect(awake.every((spell) => spell.endedAt !== null)).toBe(true);
});

test("a cancelled item's VM is deleted", async () => {
  const w = await world();
  const vm = await awakeVm(w);
  await setState(w.db, "cancelled");
  await w.sweep();
  expect((await vms(w.db))[0]).toMatchObject({ id: vm.id, state: "deleted" });
});

test("seven days asleep deletes the VM, and the resumed item gets a new one", async () => {
  const w = await world();
  const vm = await awakeVm(w);
  await setState(w.db, "awaiting_input");
  await w.sweep();
  expect((await vms(w.db))[0]).toMatchObject({ state: "asleep" });
  const sleptAt = (await vms(w.db))[0]!.stateAt;

  w.clock.t = sleptAt + 7 * DAY - 1;
  await w.sweep();
  expect((await vms(w.db))[0]).toMatchObject({ state: "asleep" });

  w.clock.t = sleptAt + 7 * DAY;
  await w.sweep();
  expect((await vms(w.db))[0]).toMatchObject({ id: vm.id, state: "deleted" });
  expect(ops(w)).toEqual([`create:${vm.id}`, `sleep:${vm.id}`, `delete:${vm.id}`]);

  await setState(w.db, "running");
  await seed(w.db, (q) => q.orm.update(q.t.runner).set({ lastSeenAt: w.clock.t }));
  expect(await place(w)).toEqual({ wait: "Waiting for its issue VM to be created" });
  const [old, fresh, ...others] = await vms(w.db);
  expect(others).toEqual([]);
  expect(old).toMatchObject({ id: vm.id, state: "deleted" });
  expect(fresh).toMatchObject({ itemId: "PAS-1", state: "creating", hostRunnerId: "host" });
});

test("delete_after_days in the saved settings sets how long a VM may sleep", async () => {
  const w = await world();
  await seedSettings(w.db, "[issue_vm]\ndelete_after_days = 2\n");
  await awakeVm(w);
  await setState(w.db, "queued");
  await w.sweep();
  await setState(w.db, "awaiting_input");
  await w.sweep();
  const sleptAt = (await vms(w.db))[0]!.stateAt;
  w.clock.t = sleptAt + 2 * DAY;
  await w.sweep();
  expect((await vms(w.db))[0]).toMatchObject({ state: "deleted" });
});

test("a failed delete stays deleting with its failure, shows as failing and retries", async () => {
  const w = await world();
  const vm = await awakeVm(w);
  w.driver.aroundNext("delete", async () => {
    throw new Error("The VM host refused the delete");
  });
  await setState(w.db, "merged");
  await w.sweep();
  expect((await vms(w.db))[0]).toMatchObject({
    state: "deleting",
    failure: "The VM host refused the delete",
    deadlineAt: w.clock.t + ISSUE_VM_DELETE_RETRY_MS,
  });
  expect(await w.db.run((q) => failingIssueVmDeletesSteps(q, "ws"))).toMatchObject([
    { id: vm.id, itemId: "PAS-1", failure: "The VM host refused the delete" },
  ]);
  expect(await place(w)).toEqual({ wait: "Waiting for its old issue VM to be deleted" });

  await w.sweep();
  expect(ops(w).filter((op) => op.startsWith("delete"))).toHaveLength(1);

  w.clock.t += ISSUE_VM_DELETE_RETRY_MS;
  await w.sweep();
  expect((await vms(w.db))[0]).toMatchObject({ state: "deleted", failure: null });
  expect(ops(w).filter((op) => op.startsWith("delete"))).toHaveLength(2);
  expect(await w.db.run((q) => failingIssueVmDeletesSteps(q, "ws"))).toEqual([]);
});

test("a provider 404 for the VM id Paws holds counts as deleted", async () => {
  const removed: string[] = [];
  const boat: BoatIssueVms = {
    create: () => Promise.reject(new Error("not used")),
    sleep: () => Promise.resolve(),
    wake: () => Promise.resolve(),
    remove: async (name) => {
      removed.push(name);
      return "missing";
    },
  };
  const { db, close } = await tempStore();
  closers.push(close);
  await withoutForeignKeys(db);
  await insertWorkItem(db, "PAS-1");
  const now = Date.now();
  await seed(db, (q) =>
    q.orm.insert(q.t.issueVm).values({
      id: "01KBOAT0000000000000000000",
      workspaceId: "ws",
      itemId: "PAS-1",
      memberUserId: "owner",
      provider: "boat",
      state: "asleep",
      want: "asleep",
      createdAt: now,
      stateAt: now,
    }),
  );
  await setState(db, "merged");
  const driver = createBoatIssueVmDriver(boat, {
    store: db,
    getVm: () => Promise.reject(new Error("not used")),
    snapshot: "paws-base",
    vmSizes: () => undefined,
    mintToken: () => Promise.reject(new Error("not used")),
  });
  await createIssueVmSweep(db, { drivers: { boat: driver }, now: () => now })();
  expect(removed).toEqual(["paws-01kboat0000000000000000000"]);
  expect((await vms(db))[0]).toMatchObject({ state: "deleted", failure: null });
});
