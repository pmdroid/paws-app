import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  liveHostIssueVmsSteps,
  recordRunnerHostStatusSteps,
  saveVmHostSteps,
  type Db,
  type IssueVmState,
} from "../src/db";
import { setJournalSink } from "../src/journal";
import { issueVmReconciler } from "../src/runner-cli/daemon";
import { handleVmHostRunnerRequest, type VmHostRunnerView } from "../src/vm-hosts";
import { recordIssueVmSteps, setIssueVmStateSteps } from "../src/issue-vm";
import {
  createFakeIssueVmUnits,
  issueVmMachines,
  issueVmUnit,
  reconcileIssueVmHost,
  systemdIssueVmUnits,
  type IssueVmHostClient,
  type IssueVmHostReport,
} from "../src/runner-daemon";
import { withoutForeignKeys } from "./pglite-fixtures";
import { tempStore } from "./pglite";

const HOST = "01JRRNNER0000000000000000A";
const OTHER = "01JRRNNER0000000000000000B";
const A = "01JVM00000000000000000000A";
const B = "01JVM00000000000000000000B";
const C = "01JVM00000000000000000000C";
const D = "01JVM00000000000000000000D";
const E = "01JVM00000000000000000000E";
const SIZE = { vcpus: 2, memoryGb: 4 };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

test("each VM gets the lowest free slot, starting it again does not double it, and stop frees it", async () => {
  const fake = createFakeIssueVmUnits();
  const machines = issueVmMachines(fake.units, () => 2);
  expect(await machines.start(A, SIZE)).toMatchObject({
    ok: true,
    started: true,
    machine: { id: A, slot: 1, unit: `paws-issue-vm@${A}-1-2-4.service` },
  });
  expect(await machines.start(B, { vcpus: 4, memoryGb: 8 })).toMatchObject({
    ok: true,
    machine: { slot: 2, unit: `paws-issue-vm@${B}-2-4-8.service` },
  });
  expect(await machines.start(A, SIZE)).toMatchObject({ ok: true, started: false });
  expect(await machines.start(C, SIZE)).toEqual({
    ok: false,
    reason: "no_slot",
    slots: 2,
    running: 2,
  });
  expect((await machines.stop(A)).map((found) => found.id)).toEqual([A]);
  expect(await machines.start(C, SIZE)).toMatchObject({ ok: true, machine: { slot: 1 } });
  expect(fake.calls.filter((call) => call.startsWith("start"))).toHaveLength(3);
  expect((await machines.running()).map((found) => found.id)).toEqual([C, B]);
  await expect(machines.start("base", SIZE)).rejects.toThrow("Not an issue VM id");
});

test("concurrent starts never pass the slot limit", async () => {
  const fake = createFakeIssueVmUnits();
  const machines = issueVmMachines(fake.units, () => 2);
  const results = await Promise.all([A, B, C, A].map((id) => machines.start(id, SIZE)));
  expect(results.map((result) => result.ok)).toEqual([true, true, false, true]);
  expect(fake.active.size).toBe(2);
});

test("a lowered slot limit refuses new VMs but keeps the running ones", async () => {
  const fake = createFakeIssueVmUnits();
  let slots = 3;
  const machines = issueVmMachines(fake.units, () => slots);
  for (const id of [A, B, C]) await machines.start(id, SIZE);
  slots = 1;
  expect(await machines.start(D, SIZE)).toMatchObject({ ok: false, running: 3 });
  expect(fake.active.size).toBe(3);
});

test("after a daemon crash the restarted daemon adopts known VMs and stops the unknown", async () => {
  const fake = createFakeIssueVmUnits();
  const before = issueVmMachines(fake.units, () => 3);
  for (const id of [A, B, C]) await before.start(id, SIZE);
  fake.active.add(issueVmUnit(A, 4, SIZE));
  fake.active.add(issueVmUnit(E, 2, SIZE));
  fake.active.add("paws-issue-vm@not-a-vm.service");

  const after = issueVmMachines(fake.units, () => 3);
  const result = await after.reconcile([
    { id: A, state: "awake" },
    { id: B, state: "asleep" },
    { id: C, state: "deleting" },
    { id: D, state: "awake" },
  ]);
  expect(result.adopted.map((found) => [found.id, found.slot])).toEqual([
    [A, 1],
    [B, 2],
  ]);
  expect(result.stopped.map(({ machine, reason }) => [machine.id, machine.slot, reason])).toEqual([
    [E, 2, "unknown"],
    [C, 3, "deleting"],
    [A, 4, "duplicate"],
  ]);
  expect(result.missing).toEqual([D]);

  expect(await after.start(A, SIZE)).toMatchObject({ ok: true, started: false });
  expect(await after.start(D, SIZE)).toMatchObject({ ok: true, machine: { slot: 3 } });
  expect(await after.start(C, SIZE)).toMatchObject({ ok: false, reason: "no_slot" });
  expect([...fake.active].sort()).toEqual(
    [issueVmUnit(A, 1, SIZE), issueVmUnit(B, 2, SIZE), issueVmUnit(D, 3, SIZE)].concat(
      "paws-issue-vm@not-a-vm.service",
    ),
  );
});

async function store(): Promise<Db> {
  const { db, close } = await tempStore();
  cleanups.push(close);
  await withoutForeignKeys(db);
  return db;
}

async function vm(db: Db, id: string, state: IssueVmState, hostRunnerId = HOST) {
  await db.run((q) =>
    recordIssueVmSteps(q, {
      id,
      workspaceId: "acme",
      itemId: `item-${id}`,
      memberUserId: "ada",
      provider: "host",
      hostRunnerId,
      now: 1,
    }),
  );
  if (state !== "creating") await db.run((q) => setIssueVmStateSteps(q, { id, state, now: 2 }));
}

test("reconcile reads the live issue VM rows on this host; ended rows and other hosts are unknown", async () => {
  const db = await store();
  await vm(db, A, "awake");
  await vm(db, B, "deleted");
  await vm(db, C, "awake", OTHER);
  await vm(db, D, "creating");
  const known = await db.run((q) => liveHostIssueVmsSteps(q, HOST));
  expect(known).toEqual([
    { id: A, state: "awake" },
    { id: D, state: "creating" },
  ]);

  const fake = createFakeIssueVmUnits();
  const machines = issueVmMachines(fake.units, () => 4);
  for (const id of [A, B, C]) await machines.start(id, SIZE);
  const result = await machines.reconcile(known);
  expect(result.adopted.map((found) => found.id)).toEqual([A]);
  expect(result.stopped.map(({ machine, reason }) => [machine.id, reason])).toEqual([
    [B, "unknown"],
    [C, "unknown"],
  ]);
  expect(result.missing).toEqual([]);
});

test("the systemd units list live paws-issue-vm units and start and stop them", async () => {
  const started: string[][] = [];
  const spawn = ((argv: string[]) => {
    started.push(argv);
    const listing = [
      `paws-issue-vm@${A}-1-2-4.service loaded active running Paws issue VM`,
      `paws-issue-vm@${B}-2-2-4.service loaded failed failed Paws issue VM`,
      `paws-issue-vm@${C}-3-2-4.service loaded deactivating stop-sigterm Paws issue VM`,
      "",
    ].join("\n");
    const failed = argv.includes(`paws-issue-vm@${D}-1-2-4.service`);
    return {
      exited: Promise.resolve(failed ? 1 : 0),
      stdout: new Response(argv[1] === "list-units" ? listing : "").body,
      stderr: new Response(failed ? "Access denied" : "").body,
    };
  }) as unknown as typeof Bun.spawn;
  const units = systemdIssueVmUnits(spawn);
  expect(await units.active()).toEqual([
    `paws-issue-vm@${A}-1-2-4.service`,
    `paws-issue-vm@${C}-3-2-4.service`,
  ]);
  await units.start(issueVmUnit(A, 1, SIZE));
  await expect(units.stop(issueVmUnit(D, 1, SIZE))).rejects.toThrow("Access denied");
  expect(started.slice(1)).toEqual([
    ["/usr/bin/systemctl", "start", "--no-ask-password", `paws-issue-vm@${A}-1-2-4.service`],
    ["/usr/bin/systemctl", "stop", "--no-ask-password", `paws-issue-vm@${D}-1-2-4.service`],
  ]);
});

function vmScript(active: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "issue-vm-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const lib = join(root, "lib");
  const dev = join(root, "dev");
  const state = join(root, "state");
  const log = join(root, "log");
  for (const dir of [bin, lib, dev]) mkdirSync(dir);
  writeFileSync(join(dev, A), "");
  const stub = (dir: string, name: string, body = "") => {
    writeFileSync(join(dir, name), `#!/bin/bash\necho "${name} $*" >>${log}\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  for (const name of ["chown", "mkfs.vfat", "mcopy"]) stub(bin, name);
  stub(
    bin,
    "systemctl",
    `[[ $1 == list-units ]] || exit 0
for unit in ${active.join(" ")}; do [[ $unit == \${@: -1}.service ]] && echo "$unit loaded active running x"; done
true`,
  );
  writeFileSync(join(bin, "awk"), '#!/bin/sh\nexec mawk "$@"\n');
  chmodSync(join(bin, "awk"), 0o755);
  stub(lib, "cloud-hypervisor");
  const run = (operation: string, instance: string) =>
    Bun.spawnSync([join(import.meta.dir, "../deploy/issue-vm/vm.sh"), operation, instance], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        PAWS_ISSUE_VM_LIB: lib,
        PAWS_ISSUE_VM_STATE: state,
        PAWS_ISSUE_VM_DEV: dev,
      },
    });
  const calls = () => readFileSync(log, "utf8");
  return { run, calls, lib, dev, state };
}

test("vm.sh seeds the VM, starts its network rules and runs Cloud Hypervisor with its disk, TAP and size", () => {
  const { run, calls, lib, dev, state } = vmScript();
  expect(run("prepare", `${A}-7-2-4`).exitCode).toBe(0);
  expect(readFileSync(join(state, A, "seed/network-config"), "utf8")).toContain(
    'addresses: [ "10.199.7.2/24" ]',
  );
  expect(readFileSync(join(state, A, "seed/meta-data"), "utf8")).toContain(`instance-id: ${A}`);
  expect(calls()).toContain(`chown paws-issue-vm ${dev}/${A}`);
  expect(calls()).toContain("systemctl start paws-issue-vm-network@7.service");
  expect(run("run", `${A}-7-2-4`).exitCode).toBe(0);
  expect(calls()).toContain(
    [
      `cloud-hypervisor --kernel ${lib}/firmware.fd`,
      `--disk path=${dev}/${A},image_type=raw path=${state}/${A}/seed.img,readonly=on,image_type=raw`,
      "--cpus boot=2 --memory size=4G",
      "--net tap=pawsvm7,ip=10.199.7.1,mask=255.255.255.0,mac=52:54:00:c7:00:07",
      `--serial file=${state}/${A}/serial.log --console off --api-socket path=${state}/${A}/api.sock`,
    ].join(" "),
  );
  expect(run("clean", `${A}-7-2-4`).exitCode).toBe(0);
  expect(calls()).toContain(`chown root ${dev}/${A}`);
  expect(calls()).toContain("systemctl stop paws-issue-vm-network@7.service");
  for (const bad of [`${A}-0-2-4`, `${A}-255-2-4`, `${A}-7-33-4`, `${A}-7-2-129`, `${A}-7-2`, "x"])
    expect(run("prepare", bad).exitCode).toBe(2);
  expect(run("prepare", `${B}-8-2-4`).exitCode).toBe(2);
});

test("vm.sh refuses a second unit for the same VM or the same slot", () => {
  const { run, calls } = vmScript([`paws-issue-vm@${A}-3-2-4.service`]);
  expect(run("prepare", `${A}-7-2-4`).exitCode).toBe(2);
  const other = vmScript([`paws-issue-vm@${B}-7-2-4.service`]);
  expect(other.run("prepare", `${A}-7-2-4`).exitCode).toBe(2);
  expect(other.run("clean", `${A}-7-2-4`).exitCode).toBe(0);
  expect(other.calls()).not.toContain("systemctl stop paws-issue-vm-network@7.service");
  expect(calls()).not.toContain("systemctl start");
});

test("vm.sh cleaning a rejected second unit for a running VM keeps its socket and disk", () => {
  const { run, calls, dev } = vmScript([`paws-issue-vm@${A}-3-2-4.service`]);
  expect(run("prepare", `${A}-7-2-4`).exitCode).toBe(2);
  expect(run("clean", `${A}-7-2-4`).exitCode).toBe(0);
  expect(calls()).not.toContain(`chown root ${dev}/${A}`);
  expect(calls()).toContain("systemctl stop paws-issue-vm-network@7.service");
});

async function host(db: Db) {
  await db.run((q) =>
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
}

const request = (path: string, method = "GET", body?: unknown) =>
  new Request(`https://runner.paws.test${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

test("Paws gives a VM host its slots, VM size and live issue VMs, and journals its report", async () => {
  const db = await store();
  await host(db);
  const read = async () =>
    (await (await handleVmHostRunnerRequest(
      request("/v1/issue-vms"),
      HOST,
      db,
    ))!.json()) as VmHostRunnerView;
  expect(await read()).toEqual({ vmHost: false });
  await db.run((q) =>
    recordRunnerHostStatusSteps(q, HOST, { cpuCount: 20, memoryTotalBytes: 121 * 1024 ** 3 }, 1),
  );
  await db.run((q) =>
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
  await vm(db, A, "awake");
  await vm(db, B, "deleted");
  expect(await read()).toEqual({
    vmHost: true,
    slots: 3,
    size: { vcpus: 2, memoryGb: 4 },
    vms: [{ id: A, state: "awake" }],
  });
  expect(await handleVmHostRunnerRequest(request("/v1/other"), HOST, db)).toBeNull();

  const lines: string[] = [];
  const restore = setJournalSink((line) => lines.push(line));
  cleanups.push(restore);
  const reported = await handleVmHostRunnerRequest(
    request("/v1/issue-vms/reconciled", "POST", {
      adopted: [A],
      stopped: [{ id: C, slot: 2, reason: "unknown" }],
      missing: [D],
    }),
    HOST,
    db,
  );
  expect(await reported!.json()).toEqual({ ok: true });
  expect(lines).toContain(`issue_vm_stopped runner=${HOST} vm=${C} slot=2 reason=unknown`);
  expect(lines).toContain(`issue_vm_missing runner=${HOST} vm=${D}`);
  const bad = await handleVmHostRunnerRequest(
    request("/v1/issue-vms/reconciled", "POST", { adopted: ["base"], stopped: [], missing: [] }),
    HOST,
    db,
  );
  expect(bad!.status).toBe(400);
});

function client(view: Awaited<ReturnType<IssueVmHostClient["issueVmHost"]>>) {
  const reports: IssueVmHostReport[] = [];
  let failures = 0;
  const daemon: IssueVmHostClient & { fail(n: number): void } = {
    fail: (n) => (failures = n),
    async issueVmHost() {
      await Promise.resolve();
      if (failures-- > 0) throw new Error("Paws is unreachable");
      return view;
    },
    async postIssueVmsReconciled(report) {
      await Promise.resolve();
      reports.push(report);
    },
  };
  return { daemon, reports };
}

test("at daemon start the runner reconciles its VM units with Paws and reports the result", async () => {
  const fake = createFakeIssueVmUnits();
  for (const [id, slot] of [
    [A, 1],
    [C, 2],
  ] as const)
    fake.active.add(issueVmUnit(id, slot, SIZE));
  const { daemon, reports } = client({
    vmHost: true,
    slots: 2,
    size: SIZE,
    vms: [
      { id: A, state: "awake" },
      { id: B, state: "awake" },
    ],
  });
  const { machines, report } = await reconcileIssueVmHost(daemon, fake.units);
  expect(report).toEqual({
    adopted: [A],
    stopped: [{ id: C, slot: 2, reason: "unknown" }],
    missing: [B],
  });
  expect(reports).toEqual([report]);
  expect(await machines.start(B, SIZE)).toMatchObject({ ok: true, machine: { slot: 2 } });
  expect(await machines.start(D, SIZE)).toMatchObject({ ok: false, reason: "no_slot", slots: 2 });
});

test("a runner that is no VM host stops every VM unit, and a failed reconcile retries a minute later", async () => {
  const fake = createFakeIssueVmUnits();
  fake.active.add(issueVmUnit(A, 1, SIZE));
  const { daemon, reports } = client({ vmHost: false });
  daemon.fail(1);
  let now = 0;
  const failures: Error[] = [];
  const tick = issueVmReconciler(
    daemon,
    fake.units,
    (error) => failures.push(error),
    () => now,
  );
  await tick();
  expect(failures.map((error) => error.message)).toEqual(["Paws is unreachable"]);
  now = 30_000;
  await tick();
  expect(reports).toEqual([]);
  now = 60_000;
  await tick();
  expect(reports).toEqual([
    { adopted: [], stopped: [{ id: A, slot: 1, reason: "unknown" }], missing: [] },
  ]);
  now = 200_000;
  await tick();
  expect(reports).toHaveLength(1);
  expect(fake.active.size).toBe(0);
  await issueVmReconciler(daemon, null, () => undefined)();
  expect(reports).toHaveLength(1);
});
