import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { join } from "node:path";
import {
  enrollRunnerSteps,
  recordRunnerHostStatusSteps,
  saveVmHostSteps,
  setIssueVmWantSteps,
  type Db,
  type IssueVmState,
} from "../src/db";
import { createHostIssueVmDriver, recordIssueVmSteps, setIssueVmStateSteps } from "../src/issue-vm";
import { setJournalSink } from "../src/journal";
import { issueVmReconciler } from "../src/runner-cli/daemon";
import {
  createFakeIssueVmDiskHelper,
  createFakeIssueVmUnits,
  issueVmDisks,
  issueVmUnit,
  reconcileIssueVms,
  systemdIssueVmUnits,
  type IssueVmHostView,
} from "../src/runner-daemon";
import { handleVmHostRunnerRequest, type VmHostRunnerView } from "../src/vm-hosts";
import { workspaceTokenHash } from "../src/workspace";
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

test("the host stages the bootstrap token Paws hands it for a VM before starting it", async () => {
  const fake = createFakeIssueVmUnits();
  const dir = mkdtempSync(join(tmpdir(), "paws-issue-vm-enroll-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const enrollDir = join(dir, "enroll");
  const listed = view(3, { [A]: "awake", [B]: "awake" });
  if (listed.vmHost) listed.vms[0]!.token = "bootstrap-token-0123456789";
  const daemon = {
    async issueVmHost(): Promise<IssueVmHostView> {
      await Promise.resolve();
      return listed;
    },
  };
  await issueVmReconciler(daemon, fake.units, () => 0, enrollDir)();
  expect(readFileSync(join(enrollDir, A), "utf8")).toBe("bootstrap-token-0123456789");
  expect(statSync(join(enrollDir, A)).mode & 0o777).toBe(0o600);
  expect(statSync(enrollDir).mode & 0o777).toBe(0o700);
  expect(readdirSync(enrollDir)).toEqual([A]);
  expect([...fake.active].sort()).toEqual([issueVmUnit(A, 1, SIZE), issueVmUnit(B, 2, SIZE)]);
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
  const copied = join(root, "copied");
  const enroll = join(root, "enroll");
  const config = join(root, "config.json");
  for (const dir of [bin, lib, dev, copied]) mkdirSync(dir);
  writeFileSync(join(dev, A), "");
  const stub = (dir: string, name: string, body = "") => {
    writeFileSync(join(dir, name), `#!/bin/bash\necho "${name} $*" >>${log}\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  for (const name of ["chown", "mkfs.vfat"]) stub(bin, name);
  stub(
    bin,
    "mcopy",
    `for f in "$@"; do [[ -f $f && $f != *.img ]] && cp "$f" ${copied}/; done; true`,
  );
  stub(
    bin,
    "systemctl",
    `[[ $1 == list-units ]] || exit 0
for unit in ${active.join(" ")}; do [[ $unit == \${@: -1}.service || $unit == "\${@: -1}" ]] && echo "$unit loaded active running x"; done
true`,
  );
  writeFileSync(join(bin, "awk"), '#!/bin/sh\nexec mawk "$@"\n');
  chmodSync(join(bin, "awk"), 0o755);
  stub(lib, "cloud-hypervisor");
  const proc = join(root, "proc");
  const checks = join(root, "checks");
  const env = (extra: Record<string, string>) => ({
    ...extra,
    PAWS_ISSUE_VM_CHECKS: checks,
    PAWS_ISSUE_VM_PROC: proc,
    PATH: `${bin}:/usr/bin:/bin`,
    PAWS_ISSUE_VM_LIB: lib,
    PAWS_ISSUE_VM_STATE: state,
    PAWS_ISSUE_VM_DEV: dev,
    PAWS_ISSUE_VM_ENROLL: enroll,
    PAWS_ISSUE_VM_CONFIG: config,
    PAWS_ISSUE_VM_NETWORK: join(import.meta.dir, "../deploy/linux/issue-vm-network.py"),
  });
  const script = join(import.meta.dir, "../deploy/issue-vm/vm.sh");
  const run = (operation: string, instance: string, extra: Record<string, string> = {}) =>
    Bun.spawnSync([script, operation, instance], { env: env(extra) });
  const runAsync = async (operation: string, instance: string) => {
    const child = Bun.spawn([script, operation, instance], { env: env({}), stderr: "pipe" });
    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr as ReadableStream).text(),
    ]);
    return { code, stderr };
  };
  const calls = () => readFileSync(log, "utf8");
  return { run, runAsync, calls, lib, dev, state, copied, enroll, config, proc, checks };
}

test("vm.sh seeds the VM, starts its network rules and runs Cloud Hypervisor with its disk, TAP and size", () => {
  const { run, calls, lib, dev, state, copied } = vmScript();
  expect(run("prepare", `${A}-7-2-4`).exitCode).toBe(0);
  expect(readFileSync(join(copied, "network-config"), "utf8")).toContain(
    'addresses: [ "10.199.7.2/24" ]',
  );
  expect(readFileSync(join(copied, "meta-data"), "utf8")).toContain(`instance-id: ${A}-7`);
  expect(readFileSync(join(copied, "user-data"), "utf8")).toBe("#cloud-config\n{}\n");
  expect(existsSync(join(state, `seed-${A}`))).toBe(false);
  expect(calls()).toContain(`chown paws-issue-vm ${dev}/${A}`);
  expect(calls()).toContain("systemctl start paws-issue-vm-network@7.service");
  expect(run("run", `${A}-7-2-4`).exitCode).toBe(0);
  expect(calls()).toContain(
    [
      `cloud-hypervisor --kernel ${lib}/firmware.fd`,
      `--disk path=${dev}/${A},image_type=raw path=${state}/seed-${A}.img,readonly=on,image_type=raw`,
      "--cpus boot=2 --memory size=4G",
      "--net tap=pawsvm7,ip=10.199.7.1,mask=255.255.255.0,mac=52:54:00:c7:00:07",
      `--vsock cid=3,socket=${state}/${A}/vsock.sock`,
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

test("vm.sh moves a staged bootstrap token into the seed once and deletes the seed once Cloud Hypervisor holds it", () => {
  const { run, copied, enroll, config, state, proc } = vmScript();
  mkdirSync(enroll);
  writeFileSync(join(enroll, A), "bootstrap-token-0123456789");
  writeFileSync(
    config,
    '{"controlPlaneUrl":"https://paws.test:8787","runnerApiUrl":"https://public.test"}\n',
  );
  expect(run("prepare", `${A}-7-2-4`).exitCode).toBe(0);
  const userData = readFileSync(join(copied, "user-data"), "utf8");
  expect(userData).toContain(
    `content: ${Buffer.from("bootstrap-token-0123456789").toString("base64")}`,
  );
  expect(userData).toContain(
    `content: ${Buffer.from('{"controlPlaneUrl":"https://paws.test:8787","runnerApiUrl":"https://public.test"}\n').toString("base64")}`,
  );
  expect(userData).toContain(
    `paws-runner runner enroll --config /etc/paws-runner/config.json --name paws-vm-${A.toLowerCase()} --token-file /var/lib/paws-bootstrap/enrollment-token`,
  );
  expect(userData).toContain("for try in $(seq 40)");
  expect(userData).toContain(
    "    content: |\n      10.199.0.1 paws.test\n      10.199.0.2 public.test\nruncmd:",
  );
  expect(existsSync(join(enroll, A))).toBe(false);
  const seed = join(state, `seed-${A}.img`);
  expect(existsSync(seed)).toBe(true);
  mkdirSync(join(proc, "4242", "fd"), { recursive: true });
  symlinkSync(join(state, "other.img"), join(proc, "4242", "fd", "3"));
  expect(run("unseed", `${A}-7-2-4`, { MAINPID: "4243" }).exitCode).toBe(0);
  expect(existsSync(seed)).toBe(true);
  symlinkSync(seed, join(proc, "4242", "fd", "4"));
  expect(run("unseed", `${A}-7-2-4`, { MAINPID: "4242" }).exitCode).toBe(0);
  expect(existsSync(seed)).toBe(false);
  expect(run("prepare", `${A}-7-2-4`).exitCode).toBe(0);
  expect(existsSync(seed)).toBe(true);
  expect(run("clean", `${A}-7-2-4`).exitCode).toBe(0);
  expect(existsSync(seed)).toBe(false);
  writeFileSync(join(enroll, A), "not a token\n");
  expect(run("prepare", `${A}-7-2-4`).exitCode).toBe(0);
  expect(readFileSync(join(copied, "user-data"), "utf8")).toBe("#cloud-config\n{}\n");
  expect(existsSync(join(enroll, A))).toBe(false);
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
  expect((await handleVmHostRunnerRequest(request("/v1/issue-vms", "PUT"), HOST, db))!.status).toBe(
    405,
  );

  const report = async (body: unknown) =>
    handleVmHostRunnerRequest(
      new Request("https://runner.paws.test/v1/issue-vms", {
        method: "POST",
        body: JSON.stringify(body),
      }),
      HOST,
      db,
      () => 50,
    );
  expect((await report({ running: ["not-a-vm"] }))!.status).toBe(400);
  expect((await report({ running: [A], extra: true }))!.status).toBe(400);
  // A report that doesn't ask for disks (a runner that parses strictly) gets no disk size,
  // token or hold, even for the creating VM.
  expect(await (await report({ running: [A, E] }))!.json()).toEqual({
    vmHost: true,
    slots: 3,
    size: { vcpus: 2, memoryGb: 4 },
    vms: [
      { id: A, state: "awake", want: "awake" },
      { id: D, state: "creating", want: "awake" },
    ],
  });

  const units = await db.run((q) =>
    q.all(
      q.orm
        .select({
          id: q.t.issueVm.id,
          running: q.t.issueVm.unitRunning,
          at: q.t.issueVm.unitSeenAt,
        })
        .from(q.t.issueVm)
        .orderBy(q.t.issueVm.id),
    ),
  );
  expect(units).toEqual([
    { id: A, running: true, at: 50 },
    { id: B, running: null, at: null },
    { id: C, running: null, at: null },
    { id: D, running: false, at: 50 },
  ]);
});

test("with each row's want, the host stops units that want asleep and starts creating and woken rows", async () => {
  const fake = createFakeIssueVmUnits();
  fake.active.add(issueVmUnit(A, 1, SIZE));
  fake.active.add(issueVmUnit(E, 2, SIZE));
  const rows = (vms: [string, IssueVmState, "awake" | "asleep"][]): IssueVmHostView => ({
    vmHost: true,
    slots: 4,
    size: SIZE,
    vms: vms.map(([id, state, want]) => ({ id, state, want })),
  });
  const result = await reconcileIssueVms(
    fake.units,
    rows([
      [A, "awake", "asleep"],
      [B, "creating", "awake"],
      [C, "asleep", "awake"],
      [D, "asleep", "asleep"],
      [E, "unknown", "awake"],
    ]),
  );
  expect(result.stopped.map(({ machine, reason }) => [machine.id, reason])).toEqual([
    [A, "asleep"],
  ]);
  expect(result.kept.map((found) => found.id)).toEqual([E]);
  expect(result.started.map((found) => [found.id, found.slot])).toEqual([
    [B, 1],
    [C, 3],
  ]);
});

test("the daemon reports its running units before and after a pass that changed them", async () => {
  const fake = createFakeIssueVmUnits();
  fake.active.add(issueVmUnit(A, 1, SIZE));
  const reports: (string[] | undefined)[] = [];
  const daemon = {
    async issueVmHost(running?: string[]): Promise<IssueVmHostView> {
      await Promise.resolve();
      reports.push(running);
      return {
        vmHost: true,
        slots: 2,
        size: SIZE,
        vms: [
          { id: A, state: "awake", want: "asleep" },
          { id: B, state: "asleep", want: "awake" },
        ],
      };
    },
  };
  let now = 0;
  const tick = issueVmReconciler(daemon, fake.units, () => (now += 30_000));
  await tick();
  expect(reports).toEqual([[A], [B]]);
  await tick();
  expect(reports).toEqual([[A], [B], [B]]);
});

test("vm.sh asks the running VM over its vsock for the sign-in check and keeps the answer for the runner", async () => {
  const { runAsync, state, checks } = vmScript([
    `paws-issue-vm@${A}-7-2-4.service`,
    `paws-issue-vm@${B}-8-2-4.service`,
  ]);
  mkdirSync(join(state, A), { recursive: true });
  let answer = "";
  const asked: string[] = [];
  const server = Bun.listen({
    unix: join(state, A, "vsock.sock"),
    socket: {
      data(socket, data) {
        asked.push(data.toString());
        socket.end(answer);
      },
    },
  });
  cleanups.push(() => server.stop(true));
  const check = async (instance: string) => {
    const { code } = await runAsync("sleep-check", instance);
    return [code, readFileSync(join(checks, `${instance}.out`), "utf8")];
  };

  answer = "OK 1073741824\nNo agent sign-ins remain.\npaws-sleep-check-exit=0\n";
  expect(await check(`${A}-7-2-4`)).toEqual([0, "No agent sign-ins remain.\n"]);
  expect(asked).toEqual(["CONNECT 7101\n"]);
  answer = "OK 1073741824\nAgent sign-ins remain: 1 sign-in file\npaws-sleep-check-exit=1\n";
  expect(await check(`${A}-7-2-4`)).toEqual([1, "Agent sign-ins remain: 1 sign-in file\n"]);
  answer = "OK 1073741824\nAgent sign-ins remain: 1 sign-in file\n";
  expect(await check(`${A}-7-2-4`)).toEqual([1, "Agent sign-ins remain: 1 sign-in file\n"]);
  answer = "";
  expect(await check(`${A}-7-2-4`)).toEqual([1, "The VM did not answer the sign-in check\n"]);

  const [code, missing] = await check(`${B}-8-2-4`);
  expect(code).toBe(1);
  expect(missing).toStartWith("The VM did not answer the sign-in check: ");
  expect(await check(`${C}-9-2-4`)).toEqual([1, `Issue VM ${C}-9-2-4 is not running\n`]);
  expect(statSync(join(checks, `${C}-9-2-4.out`)).mode & 0o777).toBe(0o644);
});

test("the polkit rule lets paws-runner start and stop issue VM units and only start their sign-in check", () => {
  const rules: ((
    action: { id: string; lookup(name: string): string | undefined },
    subject: { user: string },
  ) => unknown)[] = [];
  new Function(
    "polkit",
    readFileSync(join(import.meta.dir, "../deploy/issue-vm/paws-issue-vm.polkit"), "utf8"),
  )({ Result: { YES: "yes" }, addRule: (rule: (typeof rules)[number]) => rules.push(rule) });
  const decide = (verb: string, unit: string, user = "paws-runner") =>
    rules[0]!(
      { id: "org.freedesktop.systemd1.manage-units", lookup: (name) => ({ verb, unit })[name] },
      { user },
    );
  for (const verb of ["start", "stop"])
    expect(decide(verb, `paws-issue-vm@${A}-254-32-128.service`)).toBe("yes");
  expect(decide("start", `paws-issue-vm-sleep-check@${A}-1-2-4.service`)).toBe("yes");
  expect(decide("stop", `paws-issue-vm-sleep-check@${A}-1-2-4.service`)).toBeUndefined();
  expect(decide("restart", `paws-issue-vm@${A}-1-2-4.service`)).toBeUndefined();
  for (const unit of [
    `paws-issue-vm@${A}-255-2-4.service`,
    `paws-issue-vm-sleep-check@${A}-0-2-4.service`,
    `paws-issue-vm-sleep-check@${A}-1-2-4.service x`,
    `paws-issue-vm-other@${A}-1-2-4.service`,
  ])
    expect(decide("start", unit)).toBeUndefined();
  expect(decide("start", `paws-issue-vm@${A}-1-2-4.service`, "paws-agent")).toBeUndefined();
});

test("the systemd sign-in check starts the VM's check unit and reads why it failed", async () => {
  const checks = mkdtempSync(join(tmpdir(), "issue-vm-checks-"));
  cleanups.push(() => rmSync(checks, { recursive: true, force: true }));
  writeFileSync(join(checks, `${B}-2-2-4.out`), "Agent sign-ins remain: 1 sign-in file\n");
  const started: string[][] = [];
  const spawn = ((argv: string[]) => {
    started.push(argv);
    const failed = argv.some((arg) => arg.includes(B) || arg.includes(C));
    return {
      exited: Promise.resolve(failed ? 3 : 0),
      stdout: new Response("").body,
      stderr: new Response("").body,
    };
  }) as unknown as typeof Bun.spawn;
  const units = systemdIssueVmUnits(spawn, checks);
  expect(await units.sleepCheck(issueVmUnit(A, 1, SIZE))).toBeNull();
  expect(await units.sleepCheck(issueVmUnit(B, 2, SIZE))).toBe(
    "Agent sign-ins remain: 1 sign-in file\n",
  );
  expect(await units.sleepCheck(issueVmUnit(C, 3, SIZE))).toBe(
    "The sign-in check in the VM failed",
  );
  await expect(units.sleepCheck("paws-issue-vm@x.service")).rejects.toThrow("not an issue VM");
  expect(started[0]).toEqual([
    "/usr/bin/systemctl",
    "start",
    "--no-ask-password",
    `paws-issue-vm-sleep-check@${A}-1-2-4.service`,
  ]);
});

test("the host stops a VM that wants asleep only after its sign-in check passes", async () => {
  const fake = createFakeIssueVmUnits();
  const a = issueVmUnit(A, 1, SIZE);
  fake.active.add(a);
  fake.active.add(issueVmUnit(C, 2, SIZE));
  fake.refusals.set(a, "  Agent sign-ins remain: 1 sign-in file\n");
  const wanted: IssueVmHostView = {
    vmHost: true,
    slots: 2,
    size: SIZE,
    vms: [
      { id: A, state: "awake", want: "asleep" },
      { id: B, state: "creating", want: "awake" },
      { id: C, state: "deleting", want: "asleep" },
    ],
  };
  const refused = await reconcileIssueVms(fake.units, wanted);
  expect(refused.refused).toEqual([
    {
      machine: { id: A, slot: 1, ...SIZE, unit: a },
      reason: "Agent sign-ins remain: 1 sign-in file",
    },
  ]);
  expect(refused.stopped.map(({ machine, reason }) => [machine.id, reason])).toEqual([
    [C, "deleting"],
  ]);
  expect(refused.started.map((found) => [found.id, found.slot])).toEqual([[B, 2]]);
  expect(fake.calls.slice(0, 2)).toEqual([`check ${a}`, `stop ${issueVmUnit(C, 2, SIZE)}`]);
  expect(fake.active.has(a)).toBe(true);

  fake.refusals.delete(a);
  const slept = await reconcileIssueVms(fake.units, wanted);
  expect(slept.refused).toEqual([]);
  expect(slept.stopped.map(({ machine, reason }) => [machine.id, reason])).toEqual([[A, "asleep"]]);
  expect(fake.calls.slice(-2)).toEqual([`check ${a}`, `stop ${a}`]);

  fake.active.add(a);
  const broken = { ...fake.units, sleepCheck: () => Promise.reject(new Error("no polkit")) };
  const failed = await reconcileIssueVms(broken, wanted);
  expect(failed.refused.map(({ reason }) => reason)).toEqual(["The sign-in check could not run"]);
  expect(fake.active.has(a)).toBe(true);
});

test("a refused sleep reaches Paws, which fails the host VM's sleep with the reason", async () => {
  const db = await store();
  await host(db);
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
  await db.run((q) => setIssueVmWantSteps(q, { id: A, want: "asleep" }));
  let clock = 100;
  const bodies: unknown[] = [];
  const daemon = {
    async issueVmHost(running?: string[], refused?: { id: string; reason: string }[]) {
      const body =
        refused === undefined || refused.length === 0
          ? { running, sleepCheck: true }
          : { running, refused, sleepCheck: true };
      bodies.push(body);
      const posted = new Request("https://runner.paws.test/v1/issue-vms", {
        method: "POST",
        body: JSON.stringify(body),
      });
      const response = await handleVmHostRunnerRequest(posted, HOST, db, () => clock);
      return (await response!.json()) as IssueVmHostView;
    },
  };
  const fake = createFakeIssueVmUnits();
  const a = issueVmUnit(A, 1, SIZE);
  fake.active.add(a);
  fake.refusals.set(a, "Agent sign-ins remain: 1 sign-in file");
  const tick = issueVmReconciler(daemon, fake.units, () => (clock += 30_000));
  const driver = createHostIssueVmDriver({ store: db, now: () => clock, wait: () => tick() });
  await expect(
    driver.sleep(A, { generation: 0, signal: new AbortController().signal }),
  ).rejects.toThrow(`Issue VM ${A} can't sleep yet: Agent sign-ins remain: 1 sign-in file`);
  expect(bodies).toEqual([
    { running: [A], sleepCheck: true },
    {
      running: [A],
      refused: [{ id: A, reason: "Agent sign-ins remain: 1 sign-in file" }],
      sleepCheck: true,
    },
  ]);
  expect(fake.active.has(a)).toBe(true);

  const bad = (refused: unknown) =>
    handleVmHostRunnerRequest(
      new Request("https://runner.paws.test/v1/issue-vms", {
        method: "POST",
        body: JSON.stringify({ running: [A], refused }),
      }),
      HOST,
      db,
    );
  expect((await bad([{ id: A, reason: "" }]))!.status).toBe(400);
  expect((await bad([{ id: A, reason: "x", extra: 1 }]))!.status).toBe(400);
  expect((await bad([{ id: "nope", reason: "x" }]))!.status).toBe(400);

  const unchecked = await handleVmHostRunnerRequest(
    new Request("https://runner.paws.test/v1/issue-vms", {
      method: "POST",
      body: JSON.stringify({ running: [A] }),
    }),
    HOST,
    db,
  );
  expect(((await unchecked!.json()) as IssueVmHostView & { vmHost: true }).vms).toEqual([
    { id: A, state: "awake" },
  ]);

  fake.refusals.delete(a);
  clock += 1;
  await driver.sleep(A, { generation: 0, signal: new AbortController().signal });
  expect(fake.active.has(a)).toBe(false);
});

const GIB = 1024 ** 3;

test("a creating VM gets its disk before its first start, waits while the pool is full, and a deleting or gone VM loses its disk", async () => {
  const fake = createFakeIssueVmUnits();
  const disk = createFakeIssueVmDiskHelper({ poolBytes: 100 * GIB, baseBytes: 8 * GIB });
  const disks = issueVmDisks(disk.helper);
  const rows = (diskGb: number | undefined, vms: [string, IssueVmState][]): IssueVmHostView => ({
    vmHost: true,
    slots: 4,
    size: diskGb === undefined ? SIZE : { ...SIZE, diskGb },
    vms: vms.map(([id, state]) => ({ id, state, want: "awake" })),
  });
  const first = await reconcileIssueVms(
    fake.units,
    rows(30, [
      [A, "creating"],
      [B, "creating"],
    ]),
    undefined,
    disks,
  );
  // 80 GB of the pool is usable and each VM needs its 30 GB disk and 4 GB for its memory.
  expect(first.started.map((found) => found.id)).toEqual([A, B]);
  expect([...disk.volumes.keys()].sort()).toEqual([A, B]);
  expect(disk.calls.filter((call) => call.startsWith("create-"))).toEqual([
    `create-${A}-30-4`,
    `create-${B}-30-4`,
  ]);

  const full = await reconcileIssueVms(
    fake.units,
    rows(30, [
      [A, "awake"],
      [B, "awake"],
      [C, "creating"],
    ]),
    undefined,
    disks,
  );
  expect(full.waiting).toEqual([C]);
  expect(full.started).toEqual([]);
  expect(disk.volumes.has(C)).toBe(false);

  // A row Paws lists as deleting, and one it no longer lists, lose their unit and then their disk.
  const freed = await reconcileIssueVms(
    fake.units,
    rows(30, [
      [A, "deleting"],
      [C, "creating"],
    ]),
    undefined,
    disks,
  );
  expect(freed.stopped.map(({ machine, reason }) => [machine.id, reason])).toEqual([
    [A, "deleting"],
    [B, "unknown"],
  ]);
  expect(freed.disksRemoved).toEqual([A, B]);
  expect(freed.started.map((found) => found.id)).toEqual([C]);
  expect([...disk.volumes.keys()]).toEqual([C]);

  // Without the disk size (an older Paws) the host neither clones nor removes disks.
  const calls = disk.calls.length;
  const old = await reconcileIssueVms(
    fake.units,
    rows(undefined, [[D, "creating"]]),
    undefined,
    disks,
  );
  expect(old.started.map((found) => found.id)).toEqual([D]);
  expect(old.disksRemoved).toEqual([]);
  expect(disk.calls.length).toBe(calls);
  expect([...disk.volumes.keys()]).toEqual([C]);
});

test("a runner that is no VM host in Paws stops its VMs and then removes their disks", async () => {
  const fake = createFakeIssueVmUnits();
  const disk = createFakeIssueVmDiskHelper({ poolBytes: 100 * GIB, baseBytes: 8 * GIB });
  const disks = issueVmDisks(disk.helper);
  await disks.clone(A, { diskGb: 30, memoryGb: 4 });
  await disks.clone(B, { diskGb: 30, memoryGb: 4 });
  fake.active.add(issueVmUnit(A, 1, SIZE));
  const result = await reconcileIssueVms(fake.units, { vmHost: false }, undefined, disks);
  expect(result.stopped.map(({ machine }) => machine.id)).toEqual([A]);
  expect(fake.calls).toEqual([`stop ${issueVmUnit(A, 1, SIZE)}`]);
  expect(result.disksRemoved).toEqual([A, B]);
  expect(disk.volumes.size).toBe(0);
});

test("Paws mints one live bootstrap token for a creating host VM whose unit isn't running, and records the runner it enrolls", async () => {
  const db = await store();
  await host(db);
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
  await db.run((q) =>
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
  await vm(db, A, "creating");
  await vm(db, B, "awake");
  // C's member is no longer a usable member, so C can't get a token and the host must hold it.
  await db.run((q) =>
    recordIssueVmSteps(q, {
      id: C,
      workspaceId: "acme",
      itemId: `item-${C}`,
      memberUserId: "gone",
      provider: "host",
      hostRunnerId: HOST,
      now: 1,
    }),
  );
  const report = async (running: string[]) =>
    (await (await handleVmHostRunnerRequest(
      new Request("https://runner.paws.test/v1/issue-vms?disks=1", {
        method: "POST",
        body: JSON.stringify({ running }),
      }),
      HOST,
      db,
      () => 50,
    ))!.json()) as Extract<VmHostRunnerView, { vmHost: true }>;
  const tokenOf = (seen: Awaited<ReturnType<typeof report>>) =>
    seen.vms.find((row) => row.id === A)?.token;
  const enrollments = () =>
    db.run((q) =>
      q.all(
        q.orm
          .select({
            hash: q.t.runnerEnrollment.tokenHash,
            issueVmId: q.t.runnerEnrollment.issueVmId,
            name: q.t.runnerEnrollment.name,
            expiresAt: q.t.runnerEnrollment.expiresAt,
          })
          .from(q.t.runnerEnrollment),
      ),
    );

  const first = await report([]);
  expect(first.size).toEqual({ vcpus: 2, memoryGb: 4, diskGb: 30 });
  const token = tokenOf(first);
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(first.vms.find((row) => row.id === C)).toEqual({
    id: C,
    state: "creating",
    want: "awake",
    hold: true,
  });
  expect(first.vms.find((row) => row.id === B)).toEqual({ id: B, state: "awake", want: "awake" });
  const again = tokenOf(await report([]));
  expect(again).not.toBe(token);
  // The newer token replaces the unused one, so a waiting VM holds one pending enrollment.
  expect(await enrollments()).toEqual([
    {
      hash: workspaceTokenHash(again!),
      issueVmId: A,
      name: `paws-vm-${A.toLowerCase()}`,
      expiresAt: 50 + 10 * 60_000,
    },
  ]);
  // A running unit already took its token, and a GET from an older runner never gets one.
  expect(tokenOf(await report([A]))).toBeUndefined();
  const listed = (await (await handleVmHostRunnerRequest(
    request("/v1/issue-vms"),
    HOST,
    db,
  ))!.json()) as Extract<VmHostRunnerView, { vmHost: true }>;
  expect(listed.vms.find((row) => row.id === A)).toEqual({ id: A, state: "creating" });

  await db.transaction((q) =>
    enrollRunnerSteps(q, {
      tokenHash: workspaceTokenHash(again!),
      runnerId: OTHER,
      name: `paws-vm-${A.toLowerCase()}`,
      certificate: { fingerprint: "guest", serial: "1", pem: "pem", notBefore: 0, notAfter: 1 },
      now: 60,
    }),
  );
  const row = await db.run((q) =>
    q.one(
      q.orm
        .select({ runnerId: q.t.issueVm.runnerId })
        .from(q.t.issueVm)
        .where(eq(q.t.issueVm.id, A)),
    ),
  );
  expect(row).toEqual({ runnerId: OTHER });
  // An enrolled VM needs no token, even when its unit stopped.
  expect(tokenOf(await report([]))).toBeUndefined();
});

test("the host holds a creating VM Paws couldn't give a token rather than boot it unenrolled", async () => {
  const fake = createFakeIssueVmUnits();
  const disk = createFakeIssueVmDiskHelper({ poolBytes: 100 * GIB, baseBytes: 8 * GIB });
  const result = await reconcileIssueVms(
    fake.units,
    {
      vmHost: true,
      slots: 4,
      size: { ...SIZE, diskGb: 30 },
      vms: [
        { id: A, state: "creating", want: "awake", hold: true },
        { id: B, state: "creating", want: "awake", token: "bootstrap-token-0123456789" },
      ],
    },
    undefined,
    issueVmDisks(disk.helper),
  );
  expect(result.waiting).toEqual([A]);
  expect(result.started.map((found) => found.id)).toEqual([B]);
  expect([...disk.volumes.keys()]).toEqual([B]);
});

test("host create waits for enrollment only for a VM Paws gave a token, so older host runners still create", async () => {
  const db = await store();
  await host(db);
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
  await db.run((q) =>
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
  await vm(db, A, "creating");
  await vm(db, B, "creating");
  let clock = 100;
  const report = async (running: string[], disks: boolean) =>
    (await (await handleVmHostRunnerRequest(
      new Request(`https://runner.paws.test/v1/issue-vms${disks ? "?disks=1" : ""}`, {
        method: "POST",
        body: JSON.stringify({ running }),
      }),
      HOST,
      db,
      () => clock,
    ))!.json()) as Extract<VmHostRunnerView, { vmHost: true }>;
  const call = { generation: 0, signal: new AbortController().signal };

  // A host that never asks for disks gets no token, and its VM counts as created once it runs.
  let polls = 0;
  const older = createHostIssueVmDriver({
    store: db,
    now: () => clock,
    wait: async () => {
      polls += 1;
      clock += 1;
      await report([A], false);
    },
  });
  await older.create(A, call);
  expect(polls).toBe(1);

  // A host that asks gets B's token; B's unit running isn't enough until its runner enrolls.
  const token = (await report([], true)).vms.find((row) => row.id === B)?.token;
  expect(token).toBeDefined();
  polls = 0;
  const newer = createHostIssueVmDriver({
    store: db,
    now: () => clock,
    wait: async () => {
      polls += 1;
      clock += 1;
      await report([A, B], true);
      if (polls === 3)
        await db.transaction((q) =>
          enrollRunnerSteps(q, {
            tokenHash: workspaceTokenHash(token!),
            runnerId: OTHER,
            name: `paws-vm-${B.toLowerCase()}`,
            certificate: {
              fingerprint: "guest",
              serial: "1",
              pem: "pem",
              notBefore: 0,
              notAfter: 1,
            },
            now: clock,
          }),
        );
    },
  });
  await newer.create(B, call);
  expect(polls).toBe(3);
});
