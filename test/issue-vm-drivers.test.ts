import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfigToml } from "../src/config";
import {
  enrollRunnerSteps,
  recordRunnerHostStatusSteps,
  saveIssueVmSpendSettingsSteps,
  saveVmHostSteps,
  type Db,
  type IssueVm,
} from "../src/db";
import {
  createBoatIssueVmDriver,
  createBoatIssueVms,
  createHostIssueVmDriver,
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
import { issueVmReconciler } from "../src/runner-cli/daemon";
import {
  createFakeIssueVmDiskHelper,
  createFakeIssueVmUnits,
  issueVmDisks,
  type IssueVmHostView,
} from "../src/runner-daemon";
import { handleVmHostRunnerRequest } from "../src/vm-hosts";
import { workspaceTokenHash } from "../src/workspace";
import { describePglite, withoutForeignKeys, type PgliteTestDb } from "./pglite-fixtures";

const NOW = Date.UTC(2026, 10, 10);
const SIZES = parseConfigToml(
  "[vm_sizes.boat]\ncpu = 8\nmemory_gb = 16\n\n[vm_sizes.instabox]\ncpu = 4\nmemory_gb = 8\n",
).vmSizes;

const opened: PgliteTestDb[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Provider = "boat" | "instabox" | "host";

const HOST = "01JRRNNER0000000000000000A";
const GUEST = "01JRRNNER0000000000000000B";
const GIB = 1024 ** 3;

type Subject = {
  driver: IssueVmDriver;
  hostRunnerId?: string;
  sizeOf(id: string): unknown;
  stateOf(id: string): string | undefined;
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
    sizeOf: (id) => boat.sandboxes.get(issueVmName(id))?.size,
    stateOf: (id) => boat.sandboxes.get(issueVmName(id))?.state,
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
    sizeOf: (id) => instaBox.machines.get(issueVmName(id))?.size,
    stateOf: (id) => instaBox.machines.get(issueVmName(id))?.state,
    commands: () => instaBox.calls.flatMap((call) => call.command ?? []),
  };
}

async function hostSubject(store: Db): Promise<Subject> {
  await store.run((q) =>
    q.exec(
      q.orm.insert(q.t.runner).values({
        id: HOST,
        workspaceId: "acme",
        ownerUserId: "ada",
        name: "goldbox",
        status: "active",
        createdAt: 0,
      }),
    ),
  );
  await store.run((q) =>
    recordRunnerHostStatusSteps(q, HOST, { cpuCount: 20, memoryTotalBytes: 121 * 1024 ** 3 }, 1),
  );
  await store.run((q) =>
    saveVmHostSteps(q, {
      runnerId: HOST,
      vmVcpus: 2,
      vmMemoryGb: 4,
      vmDiskGb: 30,
      reserveVcpus: 4,
      reserveMemoryGb: 8,
      slotCap: 3,
      updatedAt: 1,
      updatedBy: "ada",
    }),
  );
  await store.run((q) =>
    q.exec(
      q.orm.insert(q.t.workspaceMember).values({
        workspaceId: "acme",
        userId: "ada",
        role: "member",
        source: "manual",
        active: 1,
        checkedAt: 0,
      }),
    ),
  );
  const units = createFakeIssueVmUnits();
  const disk = createFakeIssueVmDiskHelper({ poolBytes: 400 * GIB, baseBytes: 8 * GIB });
  const enrollDir = mkdtempSync(join(tmpdir(), "paws-issue-vm-enroll-"));
  dirs.push(enrollDir);
  // The guest's first boot: it enrolls with the token the host staged for it, once.
  const boot = async () => {
    for (const id of readdirSync(enrollDir)) {
      const token = readFileSync(join(enrollDir, id), "utf8");
      rmSync(join(enrollDir, id));
      await store.transaction((q) =>
        enrollRunnerSteps(q, {
          tokenHash: workspaceTokenHash(token),
          runnerId: GUEST,
          name: `paws-vm-${id.toLowerCase()}`,
          certificate: { fingerprint: "guest", serial: "1", pem: "pem", notBefore: 0, notAfter: 1 },
          now: 1,
        }),
      );
    }
  };
  const daemon = {
    async issueVmHost(running?: string[], _refused?: unknown, disks?: string[]) {
      const request = new Request("https://runner.paws.test/v1/issue-vms?disks=1", {
        method: "POST",
        body: JSON.stringify({ running, sleepCheck: true, disks }),
      });
      const response = await handleVmHostRunnerRequest(request, HOST, store);
      return (await response!.json()) as IssueVmHostView;
    },
  };
  let clock = 0;
  const reconcile = issueVmReconciler(
    daemon,
    units.units,
    () => (clock += 30_000),
    enrollDir,
    issueVmDisks(disk.helper),
  );
  const tick = async () => {
    await reconcile();
    await boot();
  };
  const unitOf = (id: string) => [...units.active].find((unit) => unit.includes(`@${id}-`));
  return {
    driver: createHostIssueVmDriver({ store, wait: () => tick() }),
    hostRunnerId: HOST,
    sizeOf: (id) => {
      const [, , vcpus, memoryGb] = unitOf(id)?.split("@")[1]?.split(/[-.]/) ?? [];
      return { vcpus: Number(vcpus), memoryGb: Number(memoryGb) };
    },
    stateOf: (id) =>
      unitOf(id) !== undefined ? "running" : disk.volumes.has(id) ? "stopped" : undefined,
    commands: () => [],
  };
}

const SUBJECTS: Record<
  Provider,
  {
    make: (store: Db) => Subject | Promise<Subject>;
    size: object;
    runner: (name: string) => string | null;
    sleepCheck: boolean;
    price: number | null;
  }
> = {
  boat: {
    make: boatSubject,
    size: { cpu: 8, memoryGb: 16 },
    runner: (name) => `runner-${name}`,
    sleepCheck: true,
    price: 0.5,
  },
  instabox: {
    make: instaBoxSubject,
    size: { cpu: 4, memoryGb: 8 },
    runner: (name) => `runner-${name}`,
    sleepCheck: true,
    price: 0.25,
  },
  host: {
    make: hostSubject,
    size: { vcpus: 2, memoryGb: 4 },
    runner: () => GUEST,
    sleepCheck: false,
    price: null,
  },
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
  for (const provider of ["boat", "instabox", "host"] as const) {
    test(`the ${provider} driver creates, sleeps, wakes, reconciles and deletes its VM`, async () => {
      const db = await open(connect);
      const subject = await SUBJECTS[provider].make(db);
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
            hostRunnerId: subject.hostRunnerId ?? null,
            now: t,
          });
        });

      expect(await want(true)).toMatchObject({ ok: true, vm: { state: "creating" } });
      await lifecycle.sweep();
      const created = await row(db);
      const name = issueVmName(created.id);
      const runnerId = SUBJECTS[provider].runner(name);
      expect(created).toMatchObject({ state: "awake", runnerId, failure: null });
      expect(subject.sizeOf(created.id)).toMatchObject(SUBJECTS[provider].size);
      expect(await subject.driver.reconcile(created.id, call)).toBe("awake");

      await want(false);
      await lifecycle.sweep();
      expect(await row(db)).toMatchObject({ state: "asleep", failure: null });
      if (SUBJECTS[provider].sleepCheck) expect(subject.commands()).toContain(ISSUE_VM_SLEEP_CHECK);
      expect(subject.stateOf(created.id)).not.toBe("running");
      expect(await subject.driver.reconcile(created.id, call)).toBe("asleep");

      await want(true);
      await lifecycle.sweep();
      expect(await row(db)).toMatchObject({ state: "awake", failure: null });
      expect(await subject.driver.reconcile(created.id, call)).toBe("awake");

      const spells = await db.run((q) =>
        q.all(q.orm.select().from(q.t.issueVmAwake).orderBy(q.t.issueVmAwake.startedAt)),
      );
      const price = SUBJECTS[provider].price;
      expect(spells.map((spell) => [spell.hourlyUsd, spell.endedAt === null])).toEqual([
        [price, false],
        [price, true],
      ]);

      await subject.driver.delete(created.id, call);
      expect(subject.stateOf(created.id)).toBeUndefined();
      expect(await subject.driver.reconcile(created.id, call)).toBe("missing");
    });
  }
});
