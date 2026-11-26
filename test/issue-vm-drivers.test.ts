import { afterEach, expect, test } from "bun:test";
import { parseConfigToml } from "../src/config";
import { saveIssueVmSpendSettingsSteps, type Db, type IssueVm } from "../src/db";
import {
  createBoatIssueVmDriver,
  createBoatIssueVms,
  createInstaBoxIssueVmDriver,
  createInstaBoxIssueVms,
  createIssueVmLifecycle,
  createStartQueue,
  ISSUE_VM_SLEEP_CHECK,
  issueVmName,
  requestIssueVmAsleepSteps,
  requestIssueVmAwakeSteps,
  type IssueVmDriver,
} from "../src/issue-vm";
import { createFakeBoat, createFakeBootstrap, createFakeInstaBox } from "../src/provisioning";
import { describePglite, withoutForeignKeys, type PgliteTestDb } from "./pglite-fixtures";

const NOW = Date.UTC(2026, 10, 10);
const SIZES = parseConfigToml(
  "[vm_sizes.boat]\ncpu = 8\nmemory_gb = 16\n\n[vm_sizes.instabox]\ncpu = 4\nmemory_gb = 8\n",
).vmSizes;

const opened: PgliteTestDb[] = [];
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close();
});

type Provider = "boat" | "instabox";

type Subject = {
  driver: IssueVmDriver;
  sizeOf(name: string): unknown;
  stateOf(name: string): string | undefined;
  commands(): string[];
};

function fakeClock() {
  let now = 1_000_000;
  return { now: () => now, sleep: async (ms: number) => void (now += ms) };
}

function boatSubject(store: Db): Subject {
  const clock = fakeClock();
  const ids = new Map<string, string>();
  const boat = createFakeBoat({ now: clock.now, lookup: (name) => ids.get(name) ?? null });
  const vms = createBoatIssueVms({
    boat,
    bootstrap: createFakeBootstrap(),
    queue: createStartQueue({ startsPerMinute: 10, clock }),
    readToken: () => "boat_fake-key",
    remember: (name, id) => void ids.set(name, id),
    clock,
  });
  const driver = createBoatIssueVmDriver(vms, {
    store,
    getVm: (name) => boat.getVm(name),
    snapshot: "paws-issue-vm",
    vmSizes: () => SIZES,
    mintToken: async (id) => `token-${id}`,
  });
  return {
    driver,
    sizeOf: (name) => boat.sandboxes.get(name)?.size,
    stateOf: (name) => boat.sandboxes.get(name)?.state,
    commands: () => boat.calls.flatMap((call) => call.command ?? []),
  };
}

function instaBoxSubject(store: Db): Subject {
  const clock = fakeClock();
  const instaBox = createFakeInstaBox({ now: clock.now });
  const vms = createInstaBoxIssueVms({
    instaBox,
    bootstrap: createFakeBootstrap(),
    queue: createStartQueue({ startsPerMinute: 10, clock }),
    readToken: () => "ibk_fake-key",
    remember: () => undefined,
    clock,
  });
  const driver = createInstaBoxIssueVmDriver(vms, {
    store,
    getVm: (name) => instaBox.getVm(name),
    snapshot: "snap_paws-issue-vm",
    vmSizes: () => SIZES,
    mintToken: async (id) => `token-${id}`,
  });
  return {
    driver,
    sizeOf: (name) => instaBox.machines.get(name)?.size,
    stateOf: (name) => instaBox.machines.get(name)?.state,
    commands: () => instaBox.calls.flatMap((call) => call.command ?? []),
  };
}

const SUBJECTS: Record<Provider, { make: (store: Db) => Subject; size: object }> = {
  boat: { make: boatSubject, size: { cpu: 8, memoryGb: 16 } },
  instabox: { make: instaBoxSubject, size: { cpu: 4, memoryGb: 8 } },
};

async function open(connect: () => Promise<PgliteTestDb>) {
  const handle = await connect();
  opened.push(handle);
  await withoutForeignKeys(handle.db);
  const changes = { boatHourlyUsd: 0.5, instaboxHourlyUsd: 0.25 };
  await handle.db.run((q) =>
    saveIssueVmSpendSettingsSteps(q, {
      workspaceId: "acme",
      changes,
      defaultLimitUsd: 50,
      updatedBy: "admin",
      now: NOW,
    }),
  );
  return handle.db;
}

async function row(db: Db): Promise<IssueVm> {
  const [found] = await db.run((q) => q.all(q.orm.select().from(q.t.issueVm)));
  return found as IssueVm;
}

const call = { generation: 0, signal: new AbortController().signal };

describePglite((connect) => {
  for (const provider of ["boat", "instabox"] as const) {
    test(`the ${provider} driver creates, sleeps, wakes, reconciles and deletes its VM`, async () => {
      const db = await open(connect);
      const subject = SUBJECTS[provider].make(db);
      let t = NOW;
      const lifecycle = createIssueVmLifecycle(db, {
        drivers: { [provider]: subject.driver },
        now: () => (t += 1),
      });
      const want = (awake: boolean) =>
        db.transaction(function* (q) {
          if (!awake) return yield* requestIssueVmAsleepSteps(q, { itemId: "item-1" });
          return yield* requestIssueVmAwakeSteps(q, {
            workspaceId: "acme",
            itemId: "item-1",
            memberUserId: "ada",
            provider,
            now: t,
          });
        });

      expect(await want(true)).toMatchObject({ ok: true, vm: { state: "creating" } });
      await lifecycle.sweep();
      const created = await row(db);
      const name = issueVmName(created.id);
      expect(created).toMatchObject({ state: "awake", runnerId: `runner-${name}`, failure: null });
      expect(subject.sizeOf(name)).toMatchObject(SUBJECTS[provider].size);
      expect(await subject.driver.reconcile(created.id, call)).toBe("awake");

      await want(false);
      await lifecycle.sweep();
      expect(await row(db)).toMatchObject({ state: "asleep", failure: null });
      expect(subject.commands()).toContain(ISSUE_VM_SLEEP_CHECK);
      expect(await subject.driver.reconcile(created.id, call)).toBe("asleep");

      await want(true);
      await lifecycle.sweep();
      expect(await row(db)).toMatchObject({ state: "awake", failure: null });
      expect(await subject.driver.reconcile(created.id, call)).toBe("awake");

      const spells = await db.run((q) =>
        q.all(q.orm.select().from(q.t.issueVmAwake).orderBy(q.t.issueVmAwake.startedAt)),
      );
      const price = provider === "boat" ? 0.5 : 0.25;
      expect(spells.map((spell) => [spell.hourlyUsd, spell.endedAt === null])).toEqual([
        [price, false],
        [price, true],
      ]);

      await subject.driver.delete(created.id, call);
      expect(subject.stateOf(name)).toBeUndefined();
      expect(await subject.driver.reconcile(created.id, call)).toBe("missing");
    });
  }
});
