import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  issueVmByIdSteps,
  recordRunnerHostStatusSteps,
  saveVmHostSteps,
  type Db,
  type IssueVmState,
} from "../src/db";
import { recordIssueVmSteps, setIssueVmStateSteps } from "../src/issue-vm";
import {
  createFakeIssueVmDiskHelper,
  createIssueVmDiskReconciler,
  issueVmDisks,
  systemdIssueVmDiskHelper,
} from "../src/runner-daemon";
import { RunnerIssueVmDiskPlanSchema } from "../src/runner-protocol";
import { handleIssueVmDiskReport, handleVmHostRequest } from "../src/vm-hosts";
import type { WorkspacePrincipal } from "../src/workspace";
import { withoutForeignKeys } from "./pglite-fixtures";
import { tempStore } from "./pglite";

const GIB = 1024 ** 3;
const HOST = "01JRRNNER0000000000000000A";
const OTHER = "01JRRNNER0000000000000000B";
const A = "01JVM00000000000000000000A";
const B = "01JVM00000000000000000000B";
const C = "01JVM00000000000000000000C";
const D = "01JVM00000000000000000000D";
const E = "01JVM00000000000000000000E";
const F = "01JVM00000000000000000000F";
const SIZE = { diskGb: 30, memoryGb: 4 };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

test("a clone is a thin snapshot sized to the VM disk with its memory, listed by id and made once", async () => {
  const fake = createFakeIssueVmDiskHelper({ poolBytes: 500 * GIB, baseBytes: 8 * GIB });
  const disks = issueVmDisks(fake.helper);
  expect(await disks.clone(A, SIZE)).toEqual({ ok: true, path: `/dev/paws-issue-vms/${A}` });
  expect(await disks.clone(A, SIZE)).toEqual({ ok: true, path: `/dev/paws-issue-vms/${A}` });
  expect(fake.calls.filter((call) => call.startsWith("create-"))).toEqual([`create-${A}-30-4`]);
  expect(await disks.list()).toEqual([{ id: A, sizeBytes: 30 * GIB, memoryBytes: 4 * GIB }]);
  await expect(disks.clone("base", SIZE)).rejects.toThrow("Not an issue VM id");
});

test("a pool that would pass 80% with the new disk and its memory snapshot refuses it", async () => {
  const fake = createFakeIssueVmDiskHelper({ poolBytes: 80 * GIB, baseBytes: 8 * GIB });
  const disks = issueVmDisks(fake.helper);
  expect(await disks.clone(A, SIZE)).toMatchObject({ ok: true });
  expect(await disks.clone(B, SIZE)).toEqual({
    ok: false,
    reason: "pool_full",
    needBytes: 34 * GIB,
    freeBytes: 30 * GIB,
  });
  expect(await disks.clone(B, { diskGb: 10, memoryGb: 4 })).toMatchObject({ ok: true });
  expect(await disks.pool()).toEqual({ sizeBytes: 80 * GIB, usedBytes: 4 * GIB });
});

test("a pool whose data is already near full refuses new disks", async () => {
  const disks = issueVmDisks(async (operation) =>
    operation === "pool" ? `${100 * GIB} ${79 * GIB}\n` : "  base 8589934592 0\n",
  );
  expect(await disks.clone(A, { diskGb: 10, memoryGb: 1 })).toMatchObject({
    ok: false,
    reason: "pool_full",
    freeBytes: 1 * GIB,
  });
});

test("concurrent clones are checked one at a time against the pool", async () => {
  const fake = createFakeIssueVmDiskHelper({ poolBytes: 80 * GIB, baseBytes: 8 * GIB });
  const disks = issueVmDisks(fake.helper);
  const results = await Promise.all([disks.clone(A, SIZE), disks.clone(B, SIZE)]);
  expect(results.map((result) => result.ok)).toEqual([true, false]);
  expect([...fake.volumes.keys()]).toEqual([A]);
});

test("each existing disk counts its own memory snapshot, not the next VM's", async () => {
  const fake = createFakeIssueVmDiskHelper({ poolBytes: 100 * GIB, baseBytes: 8 * GIB });
  const disks = issueVmDisks(fake.helper);
  expect(await disks.clone(A, { diskGb: 30, memoryGb: 32 })).toMatchObject({ ok: true });
  expect(await disks.clone(B, { diskGb: 30, memoryGb: 1 })).toMatchObject({
    ok: false,
    freeBytes: 18 * GIB,
  });
});

async function store(): Promise<Db> {
  const { db, close } = await tempStore();
  cleanups.push(close);
  await withoutForeignKeys(db);
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
  await db.run((q) =>
    recordRunnerHostStatusSteps(q, HOST, { cpuCount: 20, memoryTotalBytes: 121 * GIB }, 1),
  );
  await db.run((q) =>
    saveVmHostSteps(q, {
      runnerId: HOST,
      vmVcpus: 2,
      vmMemoryGb: 4,
      vmDiskGb: 30,
      reserveVcpus: 4,
      reserveMemoryGb: 8,
      slotCap: null,
      updatedAt: 1,
      updatedBy: "ada",
    }),
  );
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

const state = async (db: Db, id: string) => (await db.run((q) => issueVmByIdSteps(q, id)))?.state;

function post(db: Db, runnerId: string, body: unknown) {
  return handleIssueVmDiskReport(
    new Request("https://runner.paws/v1/issue-vm-disks", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    runnerId,
    { db, now: () => 9 },
  ) as Promise<Response>;
}

test("Paws plans disks from issue VM rows and never deletes a volume without a deleting row", async () => {
  const db = await store();
  await vm(db, A, "deleting");
  await vm(db, B, "creating");
  await vm(db, C, "deleting");
  await vm(db, D, "deleting", OTHER);
  await vm(db, F, "creating");
  await vm(db, E, "awake");
  const volume = (id: string) => ({ id, sizeBytes: 30 * GIB, memoryBytes: 4 * GIB });
  const response = await post(db, HOST, {
    poolBytes: 200 * GIB,
    usedBytes: GIB,
    volumes: [volume(A), volume(D), volume(E), volume("01JVM0000000000000000000ZZ")],
    refused: [F],
  });
  expect(response.status).toBe(200);
  expect(RunnerIssueVmDiskPlanSchema.parse(await response.json())).toEqual({
    create: [{ id: B, diskGb: 30, memoryGb: 4 }],
    delete: [A],
  });
  expect(await state(db, C)).toBe("deleted");
  expect(await state(db, F)).toBe("failed");
  expect(await state(db, A)).toBe("deleting");
  expect(await state(db, D)).toBe("deleting");

  expect(
    (await post(db, OTHER, { poolBytes: 1, usedBytes: 0, volumes: [], refused: [] })).status,
  ).toBe(404);
  expect((await post(db, HOST, { poolBytes: -1 })).status).toBe(400);
  expect(await state(db, D)).toBe("deleting");
});

test("the runner reconciles its disks through Paws and the pool limits the host's slots", async () => {
  const db = await store();
  await vm(db, A, "deleting");
  await vm(db, B, "creating");
  const fake = createFakeIssueVmDiskHelper({ poolBytes: 200 * GIB, baseBytes: 8 * GIB });
  const disks = issueVmDisks(fake.helper);
  await disks.clone(A, SIZE);
  await disks.clone(D, SIZE);
  let at = 0;
  const reconciler = createIssueVmDiskReconciler({
    disks,
    now: () => at,
    post: async (body) =>
      RunnerIssueVmDiskPlanSchema.parse(await (await post(db, HOST, body)).json()),
  });
  await reconciler.tick();
  expect([...fake.volumes.keys()].sort()).toEqual([B, D]);
  expect(fake.volumes.get(B)).toEqual({ sizeBytes: 30 * GIB, memoryBytes: 4 * GIB });
  await reconciler.tick();
  expect(fake.calls.filter((call) => call === "list")).toHaveLength(5);
  at = 30_000;
  await reconciler.tick();
  expect(await state(db, A)).toBe("deleted");
  expect(await state(db, B)).toBe("creating");

  const view = await handleVmHostRequest(
    new Request(`http://127.0.0.1:8787/api/runners/${HOST}/vm-host`),
    { db, principal: { workspaceId: "acme", userId: "ada", role: "admin" } as WorkspacePrincipal },
  );
  expect(await view!.json()).toMatchObject({
    poolBytes: 200 * GIB,
    slots: { slots: 4, reason: "disk" },
  });
});

test("a refused clone is reported and Paws fails that issue VM", async () => {
  const db = await store();
  await vm(db, B, "creating");
  const fake = createFakeIssueVmDiskHelper({ poolBytes: 30 * GIB, baseBytes: 8 * GIB });
  let at = 0;
  const reconciler = createIssueVmDiskReconciler({
    disks: issueVmDisks(fake.helper),
    now: () => at,
    post: async (body) =>
      RunnerIssueVmDiskPlanSchema.parse(await (await post(db, HOST, body)).json()),
  });
  await reconciler.tick();
  expect(fake.volumes.size).toBe(0);
  at = 30_000;
  await reconciler.tick();
  expect(await state(db, B)).toBe("failed");
});

test("the systemd helper starts the disk unit and reads its output", async () => {
  const started: string[][] = [];
  const spawn = ((argv: string[]) => {
    started.push(argv);
    const code = argv[3]!.includes("delete") ? 1 : 0;
    return { exited: Promise.resolve(code), stderr: new Response("Access denied").body };
  }) as unknown as typeof Bun.spawn;
  const helper = systemdIssueVmDiskHelper(spawn, (path) => `read ${path}`);
  expect(await helper("list")).toBe("read /run/paws-issue-vm-disk/list.out");
  expect(started[0]).toEqual([
    "/usr/bin/systemctl",
    "start",
    "--no-ask-password",
    "paws-issue-vm-disk@list.service",
  ]);
  await expect(helper(`delete-${A}`)).rejects.toThrow("Access denied");
});

function diskScript(extendExit = 0) {
  const root = mkdtempSync(join(tmpdir(), "issue-vm-disk-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const log = join(root, "log");
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/bash\necho "${name} $*" >>${log}\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  Bun.spawnSync(["mkdir", "-p", bin]);
  stub("install", 'mkdir -p "${@: -1}"');
  stub("chgrp", "");
  stub(
    "lvs",
    `case "$*" in
*data_percent*) echo "  107374182400 25.00";;
*lv_name*) printf '  base 8589934592 \\n  pool 107374182400 \\n  ${A} 32212254720 memory_gb_4\\n  ${C} 32212254720 \\n';;
*lv_size*) echo "  8589934592";;
*/${A}) exit 0;;
*) exit 5;;
esac`,
  );
  for (const name of ["lvcreate", "lvchange", "lvremove"]) stub(name, "");
  stub("lvextend", `exit ${extendExit}`);
  const out = join(root, "out");
  const run = (operation: string) =>
    Bun.spawnSync([join(import.meta.dir, "../deploy/issue-vm/disk.sh"), "run", operation], {
      env: { PATH: `${bin}:/usr/bin:/bin`, PAWS_ISSUE_VM_DISK_OUT: out },
    });
  const read = (operation: string) => readFileSync(join(out, `${operation}.out`), "utf8");
  return { run, read, calls: () => readFileSync(log, "utf8") };
}

test("disk.sh creates, lists and deletes only issue VM volumes", () => {
  const { run, read, calls } = diskScript();
  expect(run("pool").exitCode).toBe(0);
  expect(read("pool")).toBe(`${100 * GIB} ${25 * GIB}\n`);
  expect(run("list").exitCode).toBe(0);
  expect(read("list")).toBe(`${A} 32212254720 ${4 * GIB}\n${C} 32212254720 0\n`);
  expect(run(`create-${B}-30-4`).exitCode).toBe(0);
  expect(read(`create-${B}-30-4`)).toBe(`/dev/paws-issue-vms/${B}\n`);
  expect(run(`delete-${A}`).exitCode).toBe(0);
  expect(run(`delete-${B}`).exitCode).toBe(0);
  for (const bad of [
    "delete-base",
    "delete-pool",
    `create-${B}-30`,
    `create-${B}-9-4`,
    `create-${B}-501-4`,
    `create-${B}-30-129`,
    "lvs",
  ])
    expect(run(bad).exitCode).toBe(2);
  const log = calls();
  expect(log).toContain(`lvcreate -q -s -K -n ${B} --addtag memory_gb_4 paws-issue-vms/base`);
  expect(log).toContain(`lvextend -q -L 30g paws-issue-vms/${B}`);
  expect(log).toContain(`lvchange -q -ay -K paws-issue-vms/${B}`);
  expect(log).toContain(`lvremove -q -y paws-issue-vms/${A}`);
  expect(log).not.toContain(`lvremove -q -y paws-issue-vms/${B}`);
  expect(log).not.toMatch(/lvremove .*(base|pool)/);
});

test("disk.sh fails a clone whose disk could not be grown and writes no device path", () => {
  const { run, calls } = diskScript(5);
  const result = run(`create-${B}-30-4`);
  expect(result.exitCode).not.toBe(0);
  expect(calls()).not.toContain("lvchange");
});
