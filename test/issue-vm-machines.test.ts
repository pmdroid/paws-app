import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordRunnerHostStatusSteps,
  saveVmHostSteps,
  type Db,
  type IssueVmState,
} from "../src/db";
import { recordIssueVmSteps, setIssueVmStateSteps } from "../src/issue-vm";
import { setJournalSink } from "../src/journal";
import { issueVmReconciler } from "../src/runner-cli/daemon";
import {
  createFakeIssueVmUnits,
  issueVmUnit,
  reconcileIssueVms,
  systemdIssueVmUnits,
  type IssueVmHostView,
} from "../src/runner-daemon";
import { handleVmHostRunnerRequest, type VmHostRunnerView } from "../src/vm-hosts";
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

const view = (slots: number, vms: Record<string, IssueVmState>): IssueVmHostView => ({
  vmHost: true,
  slots,
  size: SIZE,
  vms: Object.entries(vms).map(([id, state]) => ({ id, state })),
});

test("awake VMs start in the lowest free slots up to the limit, once, and wait for a freed slot", async () => {
  const fake = createFakeIssueVmUnits();
  const all = { [A]: "awake", [B]: "awake", [C]: "awake" } as const;
  const first = await reconcileIssueVms(fake.units, view(2, all));
  expect(first.started.map((found) => [found.id, found.slot, found.unit])).toEqual([
    [A, 1, `paws-issue-vm@${A}-1-2-4.service`],
    [B, 2, `paws-issue-vm@${B}-2-2-4.service`],
  ]);
  expect(first.waiting).toEqual([C]);
  const again = await reconcileIssueVms(fake.units, view(2, all));
  expect(again.started).toEqual([]);
  expect(again.kept.map((found) => found.id)).toEqual([A, B]);

  const next = await reconcileIssueVms(fake.units, view(2, { ...all, [A]: "deleting" }));
  expect(next.stopped.map(({ machine, reason }) => [machine.id, reason])).toEqual([
    [A, "deleting"],
  ]);
  expect(next.started.map((found) => [found.id, found.slot])).toEqual([[C, 1]]);
  expect(fake.calls.filter((call) => call.startsWith("start"))).toHaveLength(3);
  expect(fake.active.size).toBe(2);

  const lowered = await reconcileIssueVms(fake.units, view(1, { [B]: "awake", [C]: "awake" }));
  expect(lowered.stopped.map(({ machine, reason }) => [machine.id, reason])).toEqual([
    [B, "over_limit"],
  ]);
  const failing = {
    ...fake.units,
    start: async (unit: string) => {
      if (unit.includes(D)) throw new Error(`No disk for ${D}`);
      await fake.units.start(unit);
    },
  };
  const healed = await reconcileIssueVms(
    failing,
    view(3, { [C]: "awake", [D]: "awake", [E]: "awake" }),
  );
  expect(healed.started.map((found) => found.id)).toEqual([E]);
});

test("after a daemon crash a fresh pass keeps known VMs, stops unknown and duplicate units and restarts a lost one", async () => {
  const fake = createFakeIssueVmUnits();
  await reconcileIssueVms(fake.units, view(3, { [A]: "awake", [B]: "asleep" }));
  fake.active.add(issueVmUnit(B, 2, SIZE));
  fake.active.add(issueVmUnit(A, 4, SIZE));
  fake.active.add(issueVmUnit(E, 3, SIZE));
  fake.active.add("paws-issue-vm@not-a-vm.service");

  const lines: string[] = [];
  cleanups.push(setJournalSink((line) => lines.push(line)));
  const result = await reconcileIssueVms(
    fake.units,
    view(3, { [A]: "awake", [B]: "asleep", [D]: "awake", [C]: "awake" }),
  );
  expect(result.kept.map((found) => [found.id, found.slot])).toEqual([
    [A, 1],
    [B, 2],
  ]);
  expect(result.stopped.map(({ machine, reason }) => [machine.id, machine.slot, reason])).toEqual([
    [E, 3, "unknown"],
    [A, 4, "duplicate"],
  ]);
  expect(result.started.map((found) => [found.id, found.slot])).toEqual([[D, 3]]);
  expect(result.waiting).toEqual([C]);
  expect(lines).toContain(`issue_vm_stopped vm=${E} slot=3 reason=unknown`);
  expect(lines).toContain(`issue_vm_started vm=${D} slot=3`);
  expect(lines).toContain(`issue_vm_waiting vm=${C} slots=3`);
  expect([...fake.active].sort()).toEqual(
    [
      issueVmUnit(A, 1, SIZE),
      issueVmUnit(B, 2, SIZE),
      issueVmUnit(D, 3, SIZE),
      "paws-issue-vm@not-a-vm.service",
    ].sort(),
  );
});

test("a runner that is no VM host stops its VM units; the daemon reconciles every 30 s and keeps going after a failure", async () => {
  const fake = createFakeIssueVmUnits();
  fake.active.add(issueVmUnit(A, 1, SIZE));
  let failures = 1;
  const daemon = {
    async issueVmHost(): Promise<IssueVmHostView> {
      await Promise.resolve();
      if (failures-- > 0) throw new Error("Paws is unreachable");
      return { vmHost: false };
    },
  };
  let now = 0;
  const tick = issueVmReconciler(daemon, fake.units, () => now);
  await tick();
  expect(fake.active.size).toBe(1);
  now = 10_000;
  await tick();
  expect(fake.active.size).toBe(1);
  now = 30_000;
  await tick();
  expect(fake.active.size).toBe(0);
  await issueVmReconciler(daemon, null)();
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
  expect(readFileSync(join(state, `seed-${A}`, "network-config"), "utf8")).toContain(
    'addresses: [ "10.199.7.2/24" ]',
  );
  expect(readFileSync(join(state, `seed-${A}`, "meta-data"), "utf8")).toContain(
    `instance-id: ${A}-7`,
  );
  expect(calls()).toContain(`chown paws-issue-vm ${dev}/${A}`);
  expect(calls()).toContain("systemctl start paws-issue-vm-network@7.service");
  expect(run("run", `${A}-7-2-4`).exitCode).toBe(0);
  expect(calls()).toContain(
    [
      `cloud-hypervisor --kernel ${lib}/firmware.fd`,
      `--disk path=${dev}/${A},image_type=raw path=${state}/seed-${A}.img,readonly=on,image_type=raw`,
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

const request = (path: string, method = "GET") =>
  new Request(`https://runner.paws.test${path}`, { method });

test("Paws gives a VM host its slots, VM size and live issue VMs", async () => {
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
  await vm(db, C, "awake", OTHER);
  await vm(db, D, "creating");
  expect(await read()).toEqual({
    vmHost: true,
    slots: 3,
    size: { vcpus: 2, memoryGb: 4 },
    vms: [
      { id: A, state: "awake" },
      { id: D, state: "creating" },
    ],
  });
  expect(await handleVmHostRunnerRequest(request("/v1/other"), HOST, db)).toBeNull();
  expect(
    (await handleVmHostRunnerRequest(request("/v1/issue-vms", "POST"), HOST, db))!.status,
  ).toBe(405);
});
