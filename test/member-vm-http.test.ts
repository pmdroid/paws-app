import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../src/core";
import {
  consumeWorkspaceBootstrap,
  JobLoop,
  listRunnerOverview,
  migrate,
  openDatabase,
  putWorkspaceUser,
  syncWorkspaceMember,
} from "../src/db";
import {
  createMemberVmHttp,
  findMemberVm,
  MEMBER_VM_POLL_MS,
  registerMemberVmJob,
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

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "paws-member-vm-http-"));
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
  const person = (name: string, role: "member" | "observer"): WorkspacePrincipal => {
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
    return { workspaceId: workspace.id, userId, role, authenticatedAt: clock.now(), teamIds: [] };
  };
  const member = person("Ada Lovelace", "member");
  const observer = person("Watcher", "observer");
  const control = createRunnerControl({
    db,
    authority,
    certificateRoot: authorityRoot,
    disconnect: () => {},
    now: () => clock.now(),
  });
  const bootstrap = createFakeBootstrap({
    installPolls: 1,
    async enroll(vm, token) {
      const key = await createRunnerKey(join(root, `host-${vm}`));
      const identity = await control.enroll({ token, name: vm, csr: key.csr });
      return { runnerId: identity.runnerId, workspaceId: identity.workspaceId };
    },
  });
  const loop = new JobLoop(db, clock, { leaseMs: 60_000 });
  registerMemberVmJob(loop, {
    exeDev: createFakeExeDev(),
    bootstrap,
    mintEnrollment: (ref, request) =>
      control.createEnrollment({ ...member, userId: ref.userId }, request),
    now: () => clock.now(),
  });
  let available = true;
  const http = createMemberVmHttp({ db, available: () => available, now: () => clock.now() });
  const call = async (principal: WorkspacePrincipal, method: string, path = "/api/runners/vm") => {
    const response = await http(new Request(`https://paws.test${path}`, { method }), principal);
    if (response === null) throw new Error(`${path} was not handled`);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const drive = async (until: (row: MemberVm) => boolean) => {
    for (let index = 0; index < 500; index++) {
      const row = findMemberVm(db, member)!;
      if (until(row)) return row;
      if ((await loop.tick()) === null) clock.advance(MEMBER_VM_POLL_MS);
    }
    throw new Error("member VM did not settle");
  };
  return {
    db,
    clock,
    workspace,
    member,
    observer,
    bootstrap,
    call,
    drive,
    setAvailable: (value: boolean) => (available = value),
  };
}

const vmOf = (body: Record<string, unknown>) =>
  (body as Extract<MemberVmResponse, { available: true }>).vm as MemberVmView;
const states = (vm: MemberVmView) => vm.steps.map((entry) => `${entry.step}:${entry.state}`);

describe("member VM routes", () => {
  test("without an exe.dev token every route answers available false and starts nothing", async () => {
    const f = await fixture();
    f.setAvailable(false);
    expect(await f.call(f.member, "GET")).toEqual({ status: 200, body: { available: false } });
    expect(await f.call(f.member, "POST")).toEqual({ status: 200, body: { available: false } });
    expect(findMemberVm(f.db, f.member)).toBeNull();
  });

  test("observers are refused on every route", async () => {
    const f = await fixture();
    for (const [method, path] of [
      ["GET", "/api/runners/vm"],
      ["POST", "/api/runners/vm"],
      ["POST", "/api/runners/vm/retry"],
    ] as const)
      expect((await f.call(f.observer, method, path)).status).toBe(403);
    expect(findMemberVm(f.db, f.observer)).toBeNull();
  });

  test("other paths fall through and wrong methods answer 405", async () => {
    const f = await fixture();
    const http = createMemberVmHttp({ db: f.db, available: () => true });
    expect(await http(new Request("https://paws.test/api/runners"), f.member)).toBeNull();
    expect((await f.call(f.member, "DELETE")).status).toBe(405);
    expect((await f.call(f.member, "GET", "/api/runners/vm/retry")).status).toBe(405);
  });

  test("create, fail, retry and ready, with each step's state and elapsed time", async () => {
    const f = await fixture();
    expect(await f.call(f.member, "GET")).toEqual({
      status: 200,
      body: { available: true, vm: null },
    });

    const started = vmOf((await f.call(f.member, "POST")).body);
    expect(started.vmName).toBe("ada-lovelace-paws");
    expect(states(started)).toEqual([
      "create:running",
      "install:pending",
      "enroll:pending",
      "health:pending",
    ]);
    expect(started.steps[0]!.elapsedMs).toBe(0);
    expect(started.steps[1]!.elapsedMs).toBeNull();
    f.clock.advance(7_000);
    expect(vmOf((await f.call(f.member, "GET")).body).steps[0]!.elapsedMs).toBe(7_000);

    f.bootstrap.fail("startInstall", "the installer could not be copied");
    await f.drive((row) => row.failure !== null);
    const failed = vmOf((await f.call(f.member, "GET")).body);
    expect(states(failed)).toEqual([
      "create:done",
      "install:failed",
      "enroll:pending",
      "health:pending",
    ]);
    expect(failed.steps[0]!.elapsedMs).toBe(7_000);
    expect(failed.failure).toContain("the installer could not be copied");
    // A second start does not restart a failed VM; only retry does.
    expect(states(vmOf((await f.call(f.member, "POST")).body))[1]).toBe("install:failed");

    f.clock.advance(3_000);
    const retried = vmOf((await f.call(f.member, "POST", "/api/runners/vm/retry")).body);
    expect(retried.failure).toBeNull();
    expect(states(retried)).toEqual([
      "create:done",
      "install:running",
      "enroll:pending",
      "health:pending",
    ]);
    expect(retried.steps[1]!.elapsedMs).toBe(0);

    const health = await f.drive((row) => row.step === "health" || row.failure !== null);
    expect(health.failure).toBeNull();
    f.db.run("UPDATE runner SET last_seen_at=? WHERE id=?", [f.clock.now(), health.runnerId]);
    await f.drive((row) => row.step === "ready");
    const ready = vmOf((await f.call(f.member, "GET")).body);
    expect(ready.step).toBe("ready");
    expect(states(ready)).toEqual(["create:done", "install:done", "enroll:done", "health:done"]);
    for (const entry of ready.steps) expect(entry.elapsedMs).not.toBeNull();

    const [runner] = listRunnerOverview(f.db, f.workspace.id, f.clock.now());
    expect(runner).toMatchObject({
      id: ready.runnerId,
      ownerUserId: f.member.userId,
      ownerName: "Ada Lovelace",
    });
  });

  test("retry without a VM is refused", async () => {
    const f = await fixture();
    const response = await f.call(f.member, "POST", "/api/runners/vm/retry");
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("This member has no VM to retry.");
  });
});
