import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../src/core";
import {
  consumeWorkspaceBootstrap,
  enqueueJob,
  getRunner,
  insertRun,
  JobLoop,
  listJobs,
  migrate,
  openDatabase,
  putWorkspaceUser,
  syncWorkspaceMember,
} from "../src/db";
import {
  createMemberVmHttp,
  findMemberVm,
  getMemberVm,
  MEMBER_VM_DELETE_POLL_MS,
  MEMBER_VM_DELETE_QUEUE,
  MEMBER_VM_POLL_MS,
  MEMBER_VM_QUEUE,
  MEMBER_VM_TAILNET_LOGOUT,
  registerMemberVmDeleteJob,
  registerMemberVmJob,
  startMemberVm,
  type MemberVm,
  type MemberVmResponse,
  type MemberVmView,
} from "../src/member-vm";
import { createFakeBootstrap, createFakeExeDev, type ExeDev } from "../src/provisioning";
import { createRunnerControl } from "../src/runner-control";
import { createRunnerKey, initializeRunnerAuthority } from "../src/runner-identity";
import {
  issueWorkspaceBootstrap,
  workspaceId,
  workspaceTokenHash,
  type WorkspacePrincipal,
} from "../src/workspace";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
};

type Role = WorkspacePrincipal["role"];

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "paws-member-vm-delete-"));
  roots.push(root);
  const clock = new FakeClock(Date.UTC(2026, 9, 25));
  const db = openDatabase(join(root, "paws.sqlite"));
  migrate(db);
  const authorityRoot = join(root, "issuer");
  const authority = await initializeRunnerAuthority(authorityRoot);
  const ownerUserId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "vm-owner",
    name: "Workspace Owner",
    email: "owner@example.invalid",
  });
  const workspace = consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "vm-org",
    name: "vm-org",
    userId: ownerUserId,
    tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(db, "vm-org", clock.now())),
    now: clock.now(),
  });
  const principal = (userId: string, role: Role): WorkspacePrincipal => ({
    workspaceId: workspace.id,
    userId,
    role,
    authenticatedAt: clock.now(),
    teamIds: [],
  });
  const person = (name: string, role: Role): WorkspacePrincipal => {
    const userId = putWorkspaceUser(db, {
      id: workspaceId(),
      linearUserId: `vm-${name}`,
      name,
      email: `${name.toLowerCase().replaceAll(" ", ".")}@example.invalid`,
    });
    syncWorkspaceMember(db, {
      workspaceId: workspace.id,
      userId,
      role,
      active: true,
      teamIds: [],
      now: clock.now(),
    });
    return principal(userId, role);
  };
  const member = person("Ada Lovelace", "member");
  const colleague = person("Grace Hopper", "member");
  const admin = person("Alan Turing", "admin");
  const observer = person("Watcher", "observer");
  const owner = principal(ownerUserId, "owner");
  const disconnected: string[] = [];
  const control = createRunnerControl({
    db,
    authority,
    certificateRoot: authorityRoot,
    disconnect: () => {},
    now: () => clock.now(),
  });
  let hosts = 0;
  const exeDev = createFakeExeDev();
  const hold: {
    create: Promise<void> | null;
    enroll: Promise<void> | null;
    enrollDies: boolean;
    stalled: string | null;
    enrollStalls: boolean;
  } = {
    create: null,
    enroll: null,
    enrollDies: false,
    stalled: null,
    enrollStalls: false,
  };
  const provisioningExeDev: ExeDev = {
    ...exeDev,
    async createVm(name) {
      await hold.create;
      return exeDev.createVm(name);
    },
  };
  const bootstrap = createFakeBootstrap({
    installPolls: 1,
    async enroll(vm, token) {
      if (hold.enrollStalls) {
        hold.stalled = token;
        throw new Error("Paws stopped before the VM enrolled.");
      }
      hosts += 1;
      const key = await createRunnerKey(join(root, `host-${hosts}`));
      const identity = await control.enroll({ token, name: vm, csr: key.csr });
      await hold.enroll;
      if (hold.enrollDies) throw new Error("Paws stopped before it recorded the runner.");
      return { runnerId: identity.runnerId, workspaceId: identity.workspaceId };
    },
  });
  const stopped: string[] = [];
  const loop = new JobLoop(db, clock, { leaseMs: 60_000 });
  registerMemberVmJob(loop, {
    exeDev: provisioningExeDev,
    bootstrap,
    mintEnrollment: (ref, request) =>
      control.createEnrollment(principal(ref.userId, "member"), request),
    now: () => clock.now(),
  });
  registerMemberVmDeleteJob(loop, {
    exeDev,
    async stopTask(itemId) {
      stopped.push(itemId);
      db.run("UPDATE work_item SET cancel_requested=1,state='cancelled' WHERE id=?", [itemId]);
    },
    disconnect: (fingerprint) => disconnected.push(fingerprint),
    now: () => clock.now(),
    pollMs: MEMBER_VM_DELETE_POLL_MS,
  });
  const http = createMemberVmHttp({ db, available: () => true, now: () => clock.now() });
  const call = async (who: WorkspacePrincipal, path: string, body?: unknown) => {
    const response = await http(
      new Request(`https://paws.test${path}`, {
        method: body === undefined ? "GET" : "POST",
        ...(body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      }),
      who,
    );
    if (response === null) throw new Error(`${path} was not handled`);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const remove = (who: WorkspacePrincipal, id: string, force?: boolean) =>
    call(who, "/api/runners/vm/delete", force === undefined ? { id } : { id, force });

  const ready = async (): Promise<MemberVm> => {
    startMemberVm(db, { ...member, now: clock.now() });
    for (let index = 0; index < 500; index++) {
      const row = findMemberVm(db, member)!;
      if (row.failure !== null) throw new Error(row.failure);
      if (row.step === "health" && row.runnerId)
        db.run("UPDATE runner SET last_seen_at=? WHERE id=?", [clock.now(), row.runnerId]);
      if (row.step === "ready") return row;
      if ((await loop.tick()) === null) clock.advance(MEMBER_VM_POLL_MS);
    }
    throw new Error("member VM did not turn ready");
  };
  const settle = async () => {
    for (let index = 0; index < 50; index++) if ((await loop.tick()) === null) return;
    throw new Error("delete job did not settle");
  };
  const task = (runnerId: string, identifier: string) => {
    const itemId = `item-${identifier}`;
    db.run(
      `INSERT INTO work_item(id,delegation_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at)
      VALUES(?,?,?,?,?,'running',?,0,?)`,
      [
        itemId,
        `d-${identifier}`,
        `i-${identifier}`,
        identifier,
        "Fix the login page",
        `paws/${identifier}`,
        clock.now(),
      ],
    );
    const run = insertRun(db, { itemId, now: clock.now(), status: "active" });
    db.run(
      `INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until,last_sequence)
      VALUES(?,?,?,1,0,?,?,0)`,
      [run.id, runnerId, workspace.id, `cmd-${identifier}`, clock.now() + 600_000],
    );
    return itemId;
  };
  return {
    db,
    clock,
    hold,
    control,
    principal,
    workspace,
    member,
    colleague,
    admin,
    observer,
    owner,
    exeDev,
    bootstrap,
    loop,
    stopped,
    disconnected,
    call,
    remove,
    ready,
    settle,
    task,
  };
}

const viewOf = (body: Record<string, unknown>) =>
  (body as Extract<MemberVmResponse, { available: true }>).vm as MemberVmView;
const deleteStates = (vm: MemberVmView) =>
  vm.deleting!.steps.map((entry) => `${entry.step}:${entry.state}`);
const audits = (db: Database, action: string) =>
  db
    .query<{ n: number }, [string]>(
      "SELECT count(*) AS n FROM workspace_access_audit WHERE action=?",
    )
    .get(action)!.n;
const openJobs = (db: Database, queue: string) =>
  listJobs(db).filter(
    (job) => job.queue === queue && (job.status === "pending" || job.status === "running"),
  );

describe("Delete VM", () => {
  test("drains, leaves the tailnet, revokes, destroys and clears, in that order", async () => {
    const f = await fixture();
    const vm = await f.ready();
    const runnerId = vm.runnerId!;
    f.exeDev.calls.length = 0;

    const started = await f.remove(f.member, vm.id);
    expect(started.status).toBe(200);
    expect(deleteStates(viewOf(started.body))).toEqual([
      "drain:running",
      "tailnet:pending",
      "revoke:pending",
      "destroy:pending",
      "clear:pending",
    ]);

    await f.loop.tick();
    expect(getMemberVm(f.db, vm.id)!.deleteStep).toBe("tailnet");
    expect(getRunner(f.db, runnerId)!.status).toBe("draining");
    expect(f.exeDev.calls).toEqual([]);

    await f.loop.tick();
    expect(getMemberVm(f.db, vm.id)!.deleteStep).toBe("revoke");
    expect(f.exeDev.calls).toEqual([
      { operation: "execVm", vm: vm.vmName, command: MEMBER_VM_TAILNET_LOGOUT, timeoutMs: 60_000 },
    ]);
    expect(getRunner(f.db, runnerId)!.status).toBe("draining");

    await f.loop.tick();
    expect(getMemberVm(f.db, vm.id)!.deleteStep).toBe("destroy");
    expect(getRunner(f.db, runnerId)!.status).toBe("revoked");
    expect(f.disconnected.length).toBeGreaterThan(0);
    expect(f.exeDev.vms.has(vm.vmName)).toBe(true);

    const midway = viewOf((await f.call(f.member, "/api/runners/vm")).body);
    expect(deleteStates(midway)).toEqual([
      "drain:done",
      "tailnet:done",
      "revoke:done",
      "destroy:running",
      "clear:pending",
    ]);
    expect(midway.runnerId).toBe(runnerId);

    await f.loop.tick();
    expect(getMemberVm(f.db, vm.id)!.deleteStep).toBe("clear");
    expect(f.exeDev.calls.at(-1)).toEqual({ operation: "deleteVm", vm: vm.vmName });
    expect(f.exeDev.vms.has(vm.vmName)).toBe(false);

    await f.settle();
    expect(getMemberVm(f.db, vm.id)).toBeNull();
    expect(f.exeDev.calls.map((entry) => entry.operation)).toEqual(["execVm", "deleteVm"]);
    expect(audits(f.db, "member_vm.deleted")).toBe(1);
    expect(await f.call(f.member, "/api/runners/vm")).toEqual({
      status: 200,
      body: { available: true, vm: null, vms: [] },
    });
  });

  test("a running task blocks the delete and is named, until the delete is forced", async () => {
    const f = await fixture();
    const vm = await f.ready();
    const itemId = f.task(vm.runnerId!, "PAS-901");

    await f.remove(f.member, vm.id);
    await f.settle();
    const blocked = viewOf((await f.call(f.member, "/api/runners/vm")).body);
    expect(blocked.deleting!.step).toBe("drain");
    expect(blocked.deleting!.failure).toContain("PAS-901 is running on ada-lovelace-paws");
    expect(blocked.deleting!.blocked).toEqual([
      { itemId, identifier: "PAS-901", title: "Fix the login page" },
    ]);
    expect(deleteStates(blocked)[0]).toBe("drain:failed");
    expect(getRunner(f.db, vm.runnerId!)!.status).toBe("draining");
    expect(f.stopped).toEqual([]);
    expect(f.exeDev.vms.has(vm.vmName)).toBe(true);

    await f.remove(f.member, vm.id);
    await f.settle();
    expect(getMemberVm(f.db, vm.id)!.deleteFailure).toContain("PAS-901");
    expect(f.stopped).toEqual([]);

    const forced = await f.remove(f.member, vm.id, true);
    expect(viewOf(forced.body).deleting!.force).toBe(true);
    expect(viewOf(forced.body).deleting!.failure).toBeNull();
    await f.settle();
    expect(f.stopped).toEqual([itemId]);
    expect(audits(f.db, "member_vm.delete.stop_task")).toBe(1);
    expect(getMemberVm(f.db, vm.id)).toBeNull();
    expect(getRunner(f.db, vm.runnerId!)!.status).toBe("revoked");
    expect(f.exeDev.vms.has(vm.vmName)).toBe(false);
  });

  test("a VM exe.dev no longer has counts as destroyed", async () => {
    const f = await fixture();
    const vm = await f.ready();
    f.exeDev.vms.delete(vm.vmName);
    await f.remove(f.member, vm.id);
    await f.settle();
    expect(getMemberVm(f.db, vm.id)).toBeNull();
    expect(f.exeDev.calls.at(-1)).toEqual({ operation: "deleteVm", vm: vm.vmName });

    const g = await fixture();
    const other = await g.ready();
    g.exeDev.fail("deleteVm", "missing", { vm: other.vmName });
    await g.remove(g.member, other.id);
    await g.settle();
    expect(getMemberVm(g.db, other.id)).toBeNull();
  });

  test("a failed tailnet logout does not block the delete", async () => {
    const f = await fixture();
    const vm = await f.ready();
    f.exeDev.fail("execVm", "timeout", { command: MEMBER_VM_TAILNET_LOGOUT });
    await f.remove(f.member, vm.id);
    await f.settle();
    expect(getMemberVm(f.db, vm.id)).toBeNull();
  });

  test("a failed destroy is shown and Retry resumes at that step", async () => {
    const f = await fixture();
    const vm = await f.ready();
    f.exeDev.fail("deleteVm", "rate_limited");
    await f.remove(f.member, vm.id);
    await f.settle();
    const failed = viewOf((await f.call(f.member, "/api/runners/vm")).body);
    expect(failed.deleting!.step).toBe("destroy");
    expect(failed.deleting!.failure).toContain("rate_limited");
    expect(deleteStates(failed)).toEqual([
      "drain:done",
      "tailnet:done",
      "revoke:done",
      "destroy:failed",
      "clear:pending",
    ]);
    const logouts = f.exeDev.calls.filter((entry) => entry.operation === "execVm").length;

    await f.remove(f.member, vm.id);
    await f.settle();
    expect(getMemberVm(f.db, vm.id)).toBeNull();
    expect(f.exeDev.calls.filter((entry) => entry.operation === "execVm")).toHaveLength(logouts);
    expect(audits(f.db, "runner.revoked")).toBe(1);
  });

  test("only the VM's owner or a workspace owner or admin may delete it", async () => {
    const f = await fixture();
    const vm = await f.ready();
    for (const who of [f.colleague, f.observer]) {
      const refused = await f.remove(who, vm.id);
      expect(refused.status).toBe(403);
    }
    expect(getMemberVm(f.db, vm.id)!.deleteStep).toBeNull();
    expect(openJobs(f.db, MEMBER_VM_DELETE_QUEUE)).toHaveLength(0);
    expect((await f.remove(f.member, "01NOSUCHVM0000000000000000")).status).toBe(404);
    expect((await f.call(f.member, "/api/runners/vm/delete", { id: 7 })).status).toBe(400);

    const listed = (body: Record<string, unknown>) =>
      (body as Extract<MemberVmResponse, { available: true }>).vms.map((entry) => entry.id);
    expect(listed((await f.call(f.admin, "/api/runners/vm")).body)).toEqual([vm.id]);
    expect(listed((await f.call(f.owner, "/api/runners/vm")).body)).toEqual([vm.id]);
    expect(listed((await f.call(f.colleague, "/api/runners/vm")).body)).toEqual([]);
    expect(listed((await f.call(f.member, "/api/runners/vm")).body)).toEqual([vm.id]);

    expect((await f.remove(f.admin, vm.id)).status).toBe(200);
    await f.settle();
    expect(getMemberVm(f.db, vm.id)).toBeNull();

    const g = await fixture();
    const other = await g.ready();
    expect((await g.remove(g.owner, other.id)).status).toBe(200);
    await g.settle();
    expect(getMemberVm(g.db, other.id)).toBeNull();
  });

  test("re-running any step after it finished changes nothing more", async () => {
    const f = await fixture();
    const vm = await f.ready();
    await f.remove(f.member, vm.id);
    await f.remove(f.member, vm.id);
    expect(openJobs(f.db, MEMBER_VM_DELETE_QUEUE)).toHaveLength(1);

    const steps = ["drain", "tailnet", "revoke", "destroy"] as const;
    for (const [index, step] of steps.entries()) {
      await f.loop.tick();
      const next = index === steps.length - 1 ? "clear" : steps[index + 1]!;
      expect(getMemberVm(f.db, vm.id)!.deleteStep).toBe(next);
      f.db.run("UPDATE member_vm SET delete_step=? WHERE id=?", [step, vm.id]);
      enqueueJob(f.db, {
        queue: MEMBER_VM_DELETE_QUEUE,
        payload: { memberVmId: vm.id },
        now: f.clock.now(),
      });
      await f.loop.tick();
      const row = getMemberVm(f.db, vm.id)!;
      expect(row.deleteFailure).toBeNull();
      expect(row.deleteStep).toBe(next);
    }
    expect(audits(f.db, "runner.draining")).toBe(1);
    expect(audits(f.db, "runner.revoked")).toBe(1);
    expect(f.exeDev.calls.filter((entry) => entry.operation === "deleteVm")).toHaveLength(2);

    await f.settle();
    expect(getMemberVm(f.db, vm.id)).toBeNull();
    enqueueJob(f.db, {
      queue: MEMBER_VM_DELETE_QUEUE,
      payload: { memberVmId: vm.id },
      now: f.clock.now(),
    });
    const before = f.exeDev.calls.length;
    await f.settle();
    expect(f.exeDev.calls).toHaveLength(before);
    expect(audits(f.db, "member_vm.deleted")).toBe(1);
  });

  test("Create VM after a delete reuses the name and provisions a new runner", async () => {
    const f = await fixture();
    const vm = await f.ready();
    await f.remove(f.member, vm.id);
    await f.settle();
    expect(getMemberVm(f.db, vm.id)).toBeNull();

    const again = viewOf((await f.call(f.member, "/api/runners/vm", {})).body);
    expect(again.vmName).toBe(vm.vmName);
    expect(again.id).not.toBe(vm.id);
    const recreated = await f.ready();
    expect(recreated.runnerId).not.toBe(vm.runnerId);
    expect(getRunner(f.db, recreated.runnerId!)!.status).toBe("active");
    expect(f.exeDev.vms.has(vm.vmName)).toBe(true);
  });

  test("deleting before exe.dev was asked to create stops provisioning and touches nothing", async () => {
    const f = await fixture();
    f.exeDev.addVm("ada-lovelace-paws");
    const row = startMemberVm(f.db, { ...f.member, now: f.clock.now() });
    expect(openJobs(f.db, MEMBER_VM_QUEUE)).toHaveLength(1);
    await f.remove(f.member, row.id);
    expect(openJobs(f.db, MEMBER_VM_QUEUE)).toHaveLength(0);
    await f.settle();
    expect(getMemberVm(f.db, row.id)).toBeNull();
    expect(f.exeDev.calls).toEqual([]);
    expect(f.exeDev.vms.has("ada-lovelace-paws")).toBe(true);
  });

  test("Retry and Create VM leave a VM that is being deleted alone", async () => {
    const f = await fixture();
    const vm = await f.ready();
    await f.remove(f.member, vm.id);
    expect((await f.call(f.member, "/api/runners/vm/retry", {})).status).toBe(409);
    const same = viewOf((await f.call(f.member, "/api/runners/vm", {})).body);
    expect(same.id).toBe(vm.id);
    expect(same.deleting!.step).toBe("drain");
    expect(openJobs(f.db, MEMBER_VM_QUEUE)).toHaveLength(0);
  });
});

test("an owner or admin sees and deletes another member's VM that never got a runner", async () => {
  const f = await fixture();
  const row = startMemberVm(f.db, { ...f.member, now: f.clock.now() });
  f.exeDev.fail("createVm", "rate_limited");
  await f.settle();
  expect(getMemberVm(f.db, row.id)!.failure).toContain("rate_limited");
  expect(getMemberVm(f.db, row.id)!.runnerId).toBeNull();

  const seen = (await f.call(f.admin, "/api/runners/vm")).body as Extract<
    MemberVmResponse,
    { available: true }
  >;
  expect(seen.vm).toBeNull();
  expect(seen.vms.map((entry) => [entry.id, entry.ownerName, entry.runnerId])).toEqual([
    [row.id, "Ada Lovelace", null],
  ]);
  expect((await f.remove(f.admin, row.id)).status).toBe(200);
  await f.settle();
  expect(getMemberVm(f.db, row.id)).toBeNull();
});

describe("Delete VM while a provisioning step is still running", () => {
  const gate = () => {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => (open = resolve));
    return { promise, open };
  };
  const pump = async (f: Fixture, limit = 20) => {
    for (let index = 0; index < limit; index++)
      if ((await f.loop.tick()) === null) f.clock.advance(MEMBER_VM_DELETE_POLL_MS);
  };

  test("waits for an outstanding create and leaves a VM exe.dev refused as taken", async () => {
    const f = await fixture();
    f.exeDev.addVm("ada-lovelace-paws");
    const row = startMemberVm(f.db, { ...f.member, now: f.clock.now() });
    const held = gate();
    f.hold.create = held.promise;
    const creating = f.loop.tick();
    await Bun.sleep(5);
    expect(getMemberVm(f.db, row.id)!.createRequestedAt).not.toBeNull();

    expect((await f.remove(f.member, row.id)).status).toBe(200);
    await pump(f, 3);
    expect(getMemberVm(f.db, row.id)!.deleteStep).toBe("drain");
    expect(f.exeDev.calls.filter((call) => call.operation !== "createVm")).toEqual([]);

    held.open();
    await creating;
    expect(getMemberVm(f.db, row.id)!.createRequestedAt).toBeNull();
    await pump(f);
    expect(getMemberVm(f.db, row.id)).toBeNull();
    expect(f.exeDev.calls.map((call) => call.operation)).toEqual(["createVm"]);
    expect(f.exeDev.vms.has("ada-lovelace-paws")).toBe(true);
  });

  test("waits for an outstanding create that succeeds, then destroys the VM", async () => {
    const f = await fixture();
    const row = startMemberVm(f.db, { ...f.member, now: f.clock.now() });
    const held = gate();
    f.hold.create = held.promise;
    const creating = f.loop.tick();
    await Bun.sleep(5);
    await f.remove(f.member, row.id);
    await pump(f, 3);
    expect(getMemberVm(f.db, row.id)!.deleteStep).toBe("drain");
    held.open();
    await creating;
    await pump(f);
    expect(getMemberVm(f.db, row.id)).toBeNull();
    expect(f.exeDev.vms.has("ada-lovelace-paws")).toBe(false);
    expect(f.exeDev.calls.at(-1)).toEqual({ operation: "deleteVm", vm: "ada-lovelace-paws" });
    expect(openJobs(f.db, MEMBER_VM_QUEUE)).toHaveLength(0);
  });

  test("revokes a runner whose enrollment finishes after the delete was confirmed", async () => {
    const f = await fixture();
    const row = startMemberVm(f.db, { ...f.member, now: f.clock.now() });
    for (let index = 0; index < 100 && getMemberVm(f.db, row.id)!.step !== "enroll"; index++)
      if ((await f.loop.tick()) === null) f.clock.advance(MEMBER_VM_POLL_MS);
    expect(getMemberVm(f.db, row.id)!.step).toBe("enroll");
    const held = gate();
    f.hold.enroll = held.promise;
    const enrolling = f.loop.tick();
    for (let index = 0; index < 100; index++) {
      if (f.db.query("SELECT 1 FROM runner WHERE name='ada-lovelace-paws'").get()) break;
      await Bun.sleep(5);
    }
    const runner = f.db
      .query<{ id: string }, []>("SELECT id FROM runner WHERE name='ada-lovelace-paws'")
      .get()!;
    expect(getMemberVm(f.db, row.id)!.runnerId).toBeNull();

    await f.remove(f.member, row.id);
    expect(getMemberVm(f.db, row.id)!.deleteRunnerId).toBeNull();
    await pump(f, 3);
    expect(getMemberVm(f.db, row.id)!.deleteStep).toBe("drain");

    held.open();
    await enrolling;
    await pump(f);
    expect(getMemberVm(f.db, row.id)).toBeNull();
    expect(getRunner(f.db, runner.id)!.status).toBe("revoked");
    const live = f.db
      .query<{ n: number }, [string]>(
        "SELECT count(*) AS n FROM runner_certificate WHERE runner_id=? AND revoked_at IS NULL",
      )
      .get(runner.id)!.n;
    expect(live).toBe(0);
  });

  test("drains, blocks on and revokes a runner the VM enrolled that the row never recorded", async () => {
    const f = await fixture();
    const row = startMemberVm(f.db, { ...f.member, now: f.clock.now() });
    f.hold.enrollDies = true;
    for (let index = 0; index < 100 && getMemberVm(f.db, row.id)!.failure === null; index++)
      if ((await f.loop.tick()) === null) f.clock.advance(MEMBER_VM_POLL_MS);
    const stuck = getMemberVm(f.db, row.id)!;
    expect(stuck.step).toBe("enroll");
    expect(stuck.runnerId).toBeNull();
    const orphan = f.db
      .query<{ id: string }, []>(
        "SELECT id FROM runner WHERE name='ada-lovelace-paws' AND revoked_at IS NULL",
      )
      .get()!;
    expect(getRunner(f.db, orphan.id)!.status).toBe("active");
    const itemId = f.task(orphan.id, "PAS-902");

    const manual = f.control.createEnrollment(f.principal(f.member.userId, "member"), {
      name: "ada-lovelace-paws",
    });
    const laptop = await f.control.enroll({
      token: manual.token,
      name: "ada-lovelace-paws",
      csr: (await createRunnerKey(temp("paws-same-name-host-"))).csr,
    });

    await f.remove(f.member, row.id);
    await f.settle();
    const blocked = viewOf((await f.call(f.member, "/api/runners/vm")).body);
    expect(blocked.deleting!.step).toBe("drain");
    expect(blocked.deleting!.blocked.map((task) => task.identifier)).toEqual(["PAS-902"]);
    expect(getRunner(f.db, orphan.id)!.status).toBe("draining");
    expect(f.stopped).toEqual([]);

    await f.remove(f.member, row.id, true);
    await f.settle();
    expect(f.stopped).toEqual([itemId]);
    expect(getMemberVm(f.db, row.id)).toBeNull();
    expect(getRunner(f.db, orphan.id)!.status).toBe("revoked");
    expect(getRunner(f.db, laptop.runnerId)!.status).toBe("active");
    expect(
      f.db.query("SELECT 1 FROM member_vm_enrollment WHERE member_vm_id=?").get(row.id),
    ).toBeNull();
  });

  test("a token the VM still holds cannot enroll a runner once the delete has run", async () => {
    const f = await fixture();
    const row = startMemberVm(f.db, { ...f.member, now: f.clock.now() });
    f.hold.enrollStalls = true;
    for (let index = 0; index < 100 && getMemberVm(f.db, row.id)!.failure === null; index++)
      if ((await f.loop.tick()) === null) f.clock.advance(MEMBER_VM_POLL_MS);
    const token = f.hold.stalled!;
    expect(token).toBeTruthy();
    expect(getMemberVm(f.db, row.id)!.step).toBe("enroll");

    await f.remove(f.member, row.id);
    for (let index = 0; index < 20 && getMemberVm(f.db, row.id)!.deleteStep !== "destroy"; index++)
      await f.loop.tick();
    expect(getMemberVm(f.db, row.id)!.deleteStep).toBe("destroy");

    const key = await createRunnerKey(temp("paws-late-host-"));
    await expect(
      f.control.enroll({ token, name: "ada-lovelace-paws", csr: key.csr }),
    ).rejects.toThrow();
    await f.settle();
    expect(getMemberVm(f.db, row.id)).toBeNull();
    expect(
      f.db
        .query("SELECT 1 FROM runner WHERE name='ada-lovelace-paws' AND revoked_at IS NULL")
        .get(),
    ).toBeNull();
  });

  test("a VM made before tokens were recorded stops while an unrecorded runner of its name lives", async () => {
    const f = await fixture();
    const row = startMemberVm(f.db, { ...f.member, now: f.clock.now() });
    f.hold.enrollDies = true;
    for (let index = 0; index < 100 && getMemberVm(f.db, row.id)!.failure === null; index++)
      if ((await f.loop.tick()) === null) f.clock.advance(MEMBER_VM_POLL_MS);
    const orphan = f.db
      .query<{ id: string }, []>(
        "SELECT id FROM runner WHERE name='ada-lovelace-paws' AND revoked_at IS NULL",
      )
      .get()!;
    f.db.run("DELETE FROM member_vm_enrollment WHERE member_vm_id=?", [row.id]);
    f.db.run("UPDATE member_vm SET enrollments_tracked=0 WHERE id=?", [row.id]);

    await f.remove(f.member, row.id);
    await f.settle();
    const stopped = getMemberVm(f.db, row.id)!;
    expect(stopped.deleteStep).toBe("drain");
    expect(stopped.deleteFailure).toContain(orphan.id);
    expect(getRunner(f.db, orphan.id)!.status).toBe("active");
    expect(f.exeDev.vms.has("ada-lovelace-paws")).toBe(true);

    f.control.setStatus(f.owner, orphan.id, "revoked");
    await f.remove(f.member, row.id);
    await f.settle();
    expect(getMemberVm(f.db, row.id)).toBeNull();
    expect(f.exeDev.vms.has("ada-lovelace-paws")).toBe(false);
  });

  test("a VM made before tokens were recorded waits out a valid token for its name", async () => {
    const f = await fixture();
    const vm = await f.ready();
    f.db.run("DELETE FROM member_vm_enrollment WHERE member_vm_id=?", [vm.id]);
    f.db.run("UPDATE member_vm SET enrollments_tracked=0 WHERE id=?", [vm.id]);
    f.control.createEnrollment(f.principal(f.member.userId, "member"), { name: vm.vmName });

    await f.remove(f.member, vm.id);
    await f.settle();
    expect(getMemberVm(f.db, vm.id)!.deleteFailure).toContain("Retry after it expires");

    f.clock.advance(11 * 60_000);
    await f.remove(f.member, vm.id);
    await f.settle();
    expect(getMemberVm(f.db, vm.id)).toBeNull();
    expect(getRunner(f.db, vm.runnerId!)!.status).toBe("revoked");
  });

  test("a create cut off by a restart never removes a VM Paws cannot prove it made", async () => {
    const f = await fixture();
    f.exeDev.addVm("ada-lovelace-paws");
    const row = startMemberVm(f.db, { ...f.member, now: f.clock.now() });
    f.db.run("UPDATE member_vm SET create_requested_at=? WHERE id=?", [f.clock.now(), row.id]);
    f.db.run("UPDATE job SET status='cancelled' WHERE queue=?", [MEMBER_VM_QUEUE]);

    await f.remove(f.member, row.id);
    await f.settle();
    const failed = getMemberVm(f.db, row.id)!;
    expect(failed.deleteStep).toBe("destroy");
    expect(failed.deleteFailure).toContain("Paws left it in place");
    expect(f.exeDev.vms.has("ada-lovelace-paws")).toBe(true);
    expect(f.exeDev.calls.map((call) => call.operation)).toEqual(["getVm"]);

    f.exeDev.vms.delete("ada-lovelace-paws");
    await f.remove(f.member, row.id);
    await f.settle();
    expect(getMemberVm(f.db, row.id)).toBeNull();
    expect(f.exeDev.calls.map((call) => call.operation)).toEqual(["getVm", "getVm"]);
  });
});
