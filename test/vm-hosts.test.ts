import { afterEach, expect, test } from "bun:test";
import { listWorkspaceAuditSteps, recordRunnerHostStatusSteps, type Db } from "../src/db";
import { handleVmHostRequest, vmHostSlots, type VmHostView } from "../src/vm-hosts";
import type { WorkspacePrincipal } from "../src/workspace";
import { withoutForeignKeys } from "./pglite-fixtures";
import { tempStore } from "./pglite";

const GIB = 1024 ** 3;
const GOLDBOX = { cpuCount: 20, memoryTotalBytes: 121 * GIB };
const DEFAULTS = {
  vmVcpus: 2,
  vmMemoryGb: 4,
  vmDiskGb: 30,
  reserveVcpus: 4,
  reserveMemoryGb: 8,
  slotCap: null,
};
const RUNNER = "01JRRNNER0000000000000000A";
const url = `http://127.0.0.1:8787/api/runners/${RUNNER}/vm-host`;

test("goldbox with the default size runs 8 issue VMs, decided by CPUs", () => {
  expect(vmHostSlots(GOLDBOX, DEFAULTS)).toEqual({ slots: 8, reason: "cpu" });
  expect(vmHostSlots(GOLDBOX, { ...DEFAULTS, vmVcpus: 4, vmMemoryGb: 8 })).toEqual({
    slots: 4,
    reason: "cpu",
  });
});

test("memory, the cap and missing metrics decide the slots", () => {
  expect(vmHostSlots(GOLDBOX, { ...DEFAULTS, vmMemoryGb: 32 })).toEqual({
    slots: 3,
    reason: "memory",
  });
  expect(vmHostSlots(GOLDBOX, { ...DEFAULTS, slotCap: 3 })).toEqual({ slots: 3, reason: "cap" });
  expect(vmHostSlots({ cpuCount: 2, memoryTotalBytes: 4 * GIB }, DEFAULTS)).toEqual({
    slots: 0,
    reason: "cpu",
  });
  expect(vmHostSlots({ cpuCount: null, memoryTotalBytes: null }, DEFAULTS)).toEqual({
    slots: 0,
    reason: "unknown",
  });
});

test("the thin pool limits slots to its size less 20%, counting each VM's memory snapshot", () => {
  expect(vmHostSlots({ ...GOLDBOX, poolBytes: 200 * GIB }, DEFAULTS)).toEqual({
    slots: 4,
    reason: "disk",
  });
  expect(vmHostSlots({ ...GOLDBOX, poolBytes: 340 * GIB }, DEFAULTS)).toEqual({
    slots: 8,
    reason: "cpu",
  });
  expect(vmHostSlots({ ...GOLDBOX, poolBytes: 200 * GIB }, { ...DEFAULTS, slotCap: 2 })).toEqual({
    slots: 2,
    reason: "cap",
  });
  expect(vmHostSlots({ ...GOLDBOX, poolBytes: 20 * GIB }, DEFAULTS)).toEqual({
    slots: 0,
    reason: "disk",
  });
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function store(): Promise<Db> {
  const { db, close } = await tempStore();
  cleanups.push(close);
  await withoutForeignKeys(db);
  await db.run((q) =>
    q.exec(
      q.orm.insert(q.t.runner).values({
        id: RUNNER,
        workspaceId: "acme",
        ownerUserId: "ada",
        name: "goldbox",
        status: "active",
        createdAt: 0,
      }),
    ),
  );
  return db;
}

const principal = (role: string, workspaceId = "acme") =>
  ({ workspaceId, userId: "ada", role, authenticatedAt: 0, teamIds: [] }) as WorkspacePrincipal;

function call(db: Db, method: string, role = "admin", body?: unknown, workspaceId = "acme") {
  return handleVmHostRequest(
    new Request(url, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }),
    { db, principal: principal(role, workspaceId), now: () => 5 },
  ) as Promise<Response>;
}

test("an admin sets up a VM host, reads its slots and removes it", async () => {
  const db = await store();
  const before = (await (await call(db, "GET")).json()) as VmHostView;
  expect(before).toMatchObject({ vmHost: false, cpuCount: null, slots: { reason: "unknown" } });

  await db.run((q) => recordRunnerHostStatusSteps(q, RUNNER, GOLDBOX, 1));
  const saved = await call(db, "PUT", "admin", { vmVcpus: 4, vmMemoryGb: 8 });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({
    runnerId: RUNNER,
    vmHost: true,
    settings: { ...DEFAULTS, vmVcpus: 4, vmMemoryGb: 8 },
    cpuCount: 20,
    memoryTotalBytes: 121 * GIB,
    poolBytes: null,
    slots: { slots: 4, reason: "cpu" },
  });
  const capped = (await (await call(db, "PUT", "admin", { slotCap: 3 })).json()) as VmHostView;
  expect(capped.slots).toEqual({ slots: 3, reason: "cap" });

  const removed = (await (await call(db, "DELETE")).json()) as VmHostView;
  expect(removed).toMatchObject({ vmHost: false, settings: DEFAULTS });
  const audit = await db.run((q) => listWorkspaceAuditSteps(q, "acme", Number.MAX_SAFE_INTEGER));
  expect(JSON.stringify(audit)).toContain(`Removed VM host ${RUNNER}`);
  expect(JSON.stringify(audit)).toContain(`Set VM host ${RUNNER}: 4 vCPU, 8 GB memory`);
});

test("members are refused, out-of-range values are refused and other workspaces see nothing", async () => {
  const db = await store();
  for (const method of ["GET", "PUT", "DELETE"])
    expect((await call(db, method, "member", { vmVcpus: 2 })).status).toBe(403);
  for (const body of [
    { vmVcpus: 0 },
    { vmVcpus: 33 },
    { vmMemoryGb: 129 },
    { vmDiskGb: 9 },
    { reserveVcpus: -1 },
    { reserveMemoryGb: 257 },
    { slotCap: 0 },
    { slotCap: 65 },
    { vmVcpus: 2.5 },
    { vmVcpus: "4" },
    { cores: 4 },
    [],
  ]) {
    const response = await call(db, "PUT", "admin", body);
    expect(response.status).toBe(400);
  }
  expect((await call(db, "GET")).status).toBe(200);
  expect((await call(db, "GET", "admin", undefined, "other")).status).toBe(404);
  expect((await call(db, "POST")).status).toBe(405);
});
