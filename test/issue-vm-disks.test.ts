import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deletingHostIssueVmIdsSteps, type Db } from "../src/db";
import { recordIssueVmSteps, setIssueVmStateSteps } from "../src/issue-vm";
import {
  createFakeIssueVmDiskHelper,
  issueVmDisks,
  systemdIssueVmDiskHelper,
} from "../src/runner-daemon";
import { withoutForeignKeys } from "./pglite-fixtures";
import { tempStore } from "./pglite";

const GIB = 1024 ** 3;
const HOST = "01JRRNNER0000000000000000A";
const A = "01JVM00000000000000000000A";
const B = "01JVM00000000000000000000B";
const C = "01JVM00000000000000000000C";
const SIZE = { diskGb: 30, memoryGb: 4 };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

test("a clone is a thin snapshot sized to the VM disk, listed by id and made once", async () => {
  const fake = createFakeIssueVmDiskHelper({ poolBytes: 500 * GIB, baseBytes: 8 * GIB });
  const disks = issueVmDisks(fake.helper);
  expect(await disks.clone(A, SIZE)).toEqual({ ok: true, path: `/dev/paws-issue-vms/${A}` });
  expect(await disks.clone(A, SIZE)).toEqual({ ok: true, path: `/dev/paws-issue-vms/${A}` });
  expect(fake.calls.filter((call) => call.startsWith("create-"))).toEqual([`create-${A}-30`]);
  expect(await disks.list()).toEqual([{ id: A, sizeBytes: 30 * GIB }]);
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
  expect(fake.volumes.has(B)).toBe(true);
  expect(await disks.pool()).toEqual({ sizeBytes: 80 * GIB, usedBytes: 4 * GIB });
});

test("a pool whose data is already near full refuses new disks", async () => {
  const disks = issueVmDisks(async (operation) =>
    operation === "pool" ? `${100 * GIB} ${79 * GIB}\n` : "  base 8589934592\n",
  );
  expect(await disks.clone(A, { diskGb: 10, memoryGb: 1 })).toMatchObject({
    ok: false,
    reason: "pool_full",
    freeBytes: 1 * GIB,
  });
});

async function store(): Promise<Db> {
  const { db, close } = await tempStore();
  cleanups.push(close);
  await withoutForeignKeys(db);
  return db;
}

test("only volumes whose issue VM row on this host is deleting are removed", async () => {
  const db = await store();
  const record = (id: string, hostRunnerId: string) =>
    db.run((q) =>
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
  await record(A, HOST);
  await record(B, HOST);
  await record(C, "01JRRNNER0000000000000000B");
  for (const id of [A, C])
    await db.run((q) => setIssueVmStateSteps(q, { id, state: "deleting", now: 2 }));
  const deleting = await db.run((q) => deletingHostIssueVmIdsSteps(q, HOST));
  expect(deleting).toEqual([A]);

  const fake = createFakeIssueVmDiskHelper({ poolBytes: 500 * GIB, baseBytes: 8 * GIB });
  const disks = issueVmDisks(fake.helper);
  const orphan = "01JVM00000000000000000000D";
  for (const id of [A, B, orphan]) await disks.clone(id, SIZE);
  expect(await disks.remove([...deleting, "base"])).toEqual([A]);
  expect([...fake.volumes.keys()].sort()).toEqual([B, orphan]);
  expect(fake.calls.filter((call) => call.startsWith("delete-"))).toEqual([`delete-${A}`]);
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

test("disk.sh creates, lists and deletes only issue VM volumes", async () => {
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
*lv_name*) printf '  base 8589934592\\n  pool 107374182400\\n  ${A} 32212254720\\n';;
*lv_size*) echo "  8589934592";;
*/${A}) exit 0;;
*) exit 5;;
esac`,
  );
  for (const name of ["lvcreate", "lvextend", "lvchange", "lvremove"]) stub(name, "");
  const out = join(root, "out");
  const run = (operation: string) =>
    Bun.spawnSync([join(import.meta.dir, "../deploy/issue-vm/disk.sh"), "run", operation], {
      env: { PATH: `${bin}:/usr/bin:/bin`, PAWS_ISSUE_VM_DISK_OUT: out },
    });
  const read = (operation: string) => readFileSync(join(out, `${operation}.out`), "utf8");

  expect(run("pool").exitCode).toBe(0);
  expect(read("pool")).toBe(`${100 * GIB} ${25 * GIB}\n`);
  expect(run("list").exitCode).toBe(0);
  expect(read("list")).toBe(`${A} 32212254720\n`);
  expect(run(`create-${B}-30`).exitCode).toBe(0);
  expect(read(`create-${B}-30`)).toBe(`/dev/paws-issue-vms/${B}\n`);
  expect(run(`delete-${A}`).exitCode).toBe(0);
  expect(run(`delete-${B}`).exitCode).toBe(0);
  for (const bad of ["delete-base", "delete-pool", `create-${B}-9`, `create-${B}-501`, "lvs"])
    expect(run(bad).exitCode).toBe(2);
  const calls = readFileSync(log, "utf8");
  expect(calls).toContain(`lvcreate -q -s -K -n ${B} paws-issue-vms/base`);
  expect(calls).toContain(`lvextend -q -L 30g paws-issue-vms/${B}`);
  expect(calls).toContain(`lvchange -q -ay -K paws-issue-vms/${B}`);
  expect(calls).toContain(`lvremove -q -y paws-issue-vms/${A}`);
  expect(calls).not.toContain(`lvremove -q -y paws-issue-vms/${B}`);
  expect(calls).not.toMatch(/lvremove .*(base|pool)/);
});
