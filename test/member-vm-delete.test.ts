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
import { createFakeBootstrap, createFakeExeDev } from "../src/provisioning";
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

type Role = WorkspacePrincipal["role"];

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
  const bootstrap = createFakeBootstrap({
    installPolls: 1,
    async enroll(vm, token) {
      hosts += 1;
      const key = await createRunnerKey(join(root, `host-${hosts}`));
      const identity = await control.enroll({ token, name: vm, csr: key.csr });
      return { runnerId: identity.runnerId, workspaceId: identity.workspaceId };
    },
  });
  const stopped: string[] = [];
  const loop = new JobLoop(db, clock, { leaseMs: 60_000 });
  registerMemberVmJob(loop, {
    exeDev,
    bootstrap,
    mintEnrollment: (ref, request) =>
      control.createEnrollment(principal(ref.userId, "member"), request),
    now: () => clock.now(),
  });
  registerMemberVmDeleteJob(loop, {
    exeDev,
    // Stop marks the item cancelled; the runner's lease ends on its own later.
    async stopTask(itemId) {
      stopped.push(itemId);
      db.run("UPDATE work_item SET cancel_requested=1,state='cancelled' WHERE id=?", [itemId]);
    },
    disconnect: (fingerprint) => disconnected.push(fingerprint),
    now: () => clock.now(),
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

  /** Provision Ada's VM through to ready with a heartbeating runner. */
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
  /** Tick until the delete job has nothing left to do. */
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
    // The view keeps the runner it removes even after the revoke clears member_vm.runner_id.
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
    // Placement already skips it, but nothing else happened.
    expect(getRunner(f.db, vm.runnerId!)!.status).toBe("draining");
    expect(f.stopped).toEqual([]);
    expect(f.exeDev.vms.has(vm.vmName)).toBe(true);

    // Retry without force is blocked again by the same task.
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

    // exe.dev answering "not found" is the same.
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

    // Owners and admins see every VM they may delete; members only their own.
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
    // A second confirm while it runs queues no second job.
    await f.remove(f.member, vm.id);
    expect(openJobs(f.db, MEMBER_VM_DELETE_QUEUE)).toHaveLength(1);

    const steps = ["drain", "tailnet", "revoke", "destroy"] as const;
    for (const [index, step] of steps.entries()) {
      await f.loop.tick();
      const next = index === steps.length - 1 ? "clear" : steps[index + 1];
      expect(getMemberVm(f.db, vm.id)!.deleteStep).toBe(next);
      // As if Paws restarted after the step's effect but before it recorded the next step.
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
    // A leftover job for the cleared row is a no-op.
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
    // Someone else already owns the name on exe.dev; Paws must not remove it.
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
