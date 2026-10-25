import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../src/core";
import {
  consumeWorkspaceBootstrap,
  getRunner,
  JobLoop,
  listJobs,
  migrate,
  openDatabase,
  putWorkspaceUser,
  syncWorkspaceMember,
} from "../src/db";
import {
  findMemberVm,
  MEMBER_VM_POLL_MS,
  memberVmView,
  MEMBER_VM_QUEUE,
  registerMemberVmJob,
  retryMemberVm,
  startMemberVm,
  type MemberVm,
} from "../src/member-vm";
import {
  BootstrapError,
  createFakeBootstrap,
  createFakeExeDev,
  type ExeDev,
  type FakeBootstrap,
  type FakeExeDev,
  ProvisioningError,
} from "../src/provisioning";
import { RUNNER_FAILURE } from "../src/runner-cli";
import { createRunnerControl } from "../src/runner-control";
import { createRunnerKey, initializeRunnerAuthority } from "../src/runner-identity";
import {
  issueWorkspaceBootstrap,
  workspaceId,
  workspaceTokenHash,
  type WorkspacePrincipal,
} from "../src/workspace";

const EXE_DEV_TOKEN = "fake_exe_dev_token_for_tests_ABCDEFGHIJKLMNOP";
const LEASE_MS = 60_000;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture(input: { exeDev?: ExeDev; installPolls?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "paws-member-vm-"));
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
  const issued = issueWorkspaceBootstrap(db, "vm-org", clock.now());
  const workspace = consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "vm-org",
    name: "vm-org",
    userId: ownerUserId,
    tokenHash: workspaceTokenHash(issued),
    now: clock.now(),
  });
  const principal = (userId: string, role: WorkspacePrincipal["role"]): WorkspacePrincipal => ({
    workspaceId: workspace.id,
    userId,
    role,
    authenticatedAt: clock.now(),
    teamIds: [],
  });
  const person = (name: string, email: string, role: "member" | "observer") => {
    const userId = putWorkspaceUser(db, {
      id: workspaceId(),
      linearUserId: `vm-${email}`,
      name,
      email,
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
  const member = person("Ada Lovelace", "ada@example.invalid", "member");
  const owner = principal(ownerUserId, "owner");
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
    installPolls: input.installPolls ?? 2,
    async enroll(vm, token) {
      hosts += 1;
      const key = await createRunnerKey(join(root, `host-${hosts}`));
      const identity = await control.enroll({ token, name: vm, csr: key.csr });
      return { runnerId: identity.runnerId, workspaceId: identity.workspaceId };
    },
  });
  const jobs = (exe: ExeDev = input.exeDev ?? exeDev, boot: FakeBootstrap = bootstrap) => {
    const loop = new JobLoop(db, clock, { leaseMs: LEASE_MS });
    registerMemberVmJob(loop, {
      exeDev: exe,
      bootstrap: boot,
      mintEnrollment: (ref, request) =>
        control.createEnrollment(principal(ref.userId, "member"), request),
      secrets: () => [EXE_DEV_TOKEN],
      now: () => clock.now(),
    });
    return loop;
  };
  return { db, clock, workspace, member, owner, control, exeDev, bootstrap, person, jobs };
}

async function drive(f: Fixture, loop: JobLoop, until: (row: MemberVm) => boolean, limit = 2_000) {
  for (let index = 0; index < limit; index++) {
    const row = findMemberVm(f.db, f.member)!;
    if (until(row)) return row;
    const job = await loop.tick();
    if (job === null) f.clock.advance(MEMBER_VM_POLL_MS);
  }
  throw new Error(`member VM did not settle: ${JSON.stringify(findMemberVm(f.db, f.member))}`);
}

const settled = (row: MemberVm) => row.step === "ready" || row.failure !== null;

function openJobs(db: Database) {
  return listJobs(db).filter(
    (job) =>
      job.queue === MEMBER_VM_QUEUE && (job.status === "pending" || job.status === "running"),
  );
}

function heartbeat(db: Database, runnerId: string, at: number) {
  db.run("UPDATE runner SET last_seen_at=? WHERE id=?", [at, runnerId]);
}

describe("member VM", () => {
  test("startMemberVm inserts the row at create once and enqueues one job", async () => {
    const f = await fixture();
    const first = startMemberVm(f.db, { ...f.member, now: f.clock.now() });
    expect(first.step).toBe("create");
    expect(first.vmName).toBe("ada-lovelace-paws");
    const again = startMemberVm(f.db, { ...f.member, now: f.clock.now() });
    expect(again.id).toBe(first.id);
    expect(openJobs(f.db)).toHaveLength(1);
    const observer = f.person("Watcher", "watch@example.invalid", "observer");
    expect(() => startMemberVm(f.db, observer)).toThrow(/Active workspace membership/);
    const namesake = f.person("Ada Lovelace", "ada2@example.invalid", "member");
    expect(startMemberVm(f.db, namesake).vmName).toBe("ada-lovelace-paws-2");
  });

  test("the whole chain creates, installs, enrolls and turns ready on the first heartbeat", async () => {
    const f = await fixture();
    startMemberVm(f.db, { ...f.member, now: f.clock.now() });
    const loop = f.jobs();
    const health = await drive(f, loop, (row) => row.step === "health" || row.failure !== null);
    expect(health.failure).toBeNull();
    expect(health.runnerId).not.toBeNull();
    const runner = getRunner(f.db, health.runnerId!)!;
    expect(runner.ownerUserId).toBe(f.member.userId);
    expect(runner.workspaceId).toBe(f.workspace.id);
    expect(runner.name).toBe("ada-lovelace-paws");
    expect(f.bootstrap.calls.map((call) => call.step)).toEqual([
      "startInstall",
      "installStatus",
      "installStatus",
      "installStatus",
      "joinTailnet",
      "enroll",
      "startRunner",
    ]);
    expect(f.exeDev.calls.filter((call) => call.operation === "createVm")).toHaveLength(1);

    f.clock.advance(MEMBER_VM_POLL_MS);
    await loop.tick();
    expect(findMemberVm(f.db, f.member)!.step).toBe("health");
    heartbeat(f.db, health.runnerId!, f.clock.now());
    const ready = await drive(f, loop, settled);
    expect(ready.step).toBe("ready");
    expect(ready.failure).toBeNull();
    expect(openJobs(f.db)).toHaveLength(0);
    expect(startMemberVm(f.db, f.member).id).toBe(ready.id);
    expect(openJobs(f.db)).toHaveLength(0);
  });

  test("a restart mid-step resumes the recorded step without a second VM", async () => {
    const f = await fixture();
    startMemberVm(f.db, { ...f.member, now: f.clock.now() });
    const dying: ExeDev = {
      ...f.exeDev,
      async createVm(name) {
        await f.exeDev.createVm(name);
        return new Promise(() => {});
      },
    };
    void f.jobs(dying).tick();
    await Bun.sleep(5);
    expect(findMemberVm(f.db, f.member)!.step).toBe("create");
    expect(f.exeDev.vms.size).toBe(1);

    f.clock.advance(LEASE_MS + 1);
    const restarted = f.jobs();
    const row = await drive(f, restarted, (value) => value.step === "health" || !!value.failure);
    expect(row.failure).toBeNull();
    expect(f.exeDev.vms.size).toBe(1);
    expect(f.exeDev.calls.filter((call) => call.operation === "createVm")).toHaveLength(2);
    expect(f.bootstrap.calls.filter((call) => call.step === "startInstall")).toHaveLength(1);
  });

  test("a conflict on a name Paws never asked for is a failure", async () => {
    const f = await fixture();
    f.exeDev.addVm("ada-lovelace-paws");
    startMemberVm(f.db, { ...f.member, now: f.clock.now() });
    const loop = f.jobs();
    const row = await drive(f, loop, settled);
    expect(row.step).toBe("create");
    expect(row.failure).toMatch(/conflict/);
    expect(row.createRequestedAt).toBeNull();
    retryMemberVm(f.db, { ...f.member, now: f.clock.now() });
    const again = await drive(f, loop, settled);
    expect(again.step).toBe("create");
    expect(again.failure).toMatch(/did not create/);
    expect(f.bootstrap.calls).toHaveLength(0);
    expect(f.bootstrap.tokens).toHaveLength(0);
  });

  test("a rejected first request does not make a later conflict look like Paws' own VM", async () => {
    const exeDev = createFakeExeDev();
    exeDev.addVm("ada-lovelace-paws");
    exeDev.fail("createVm", "rate_limited");
    const f = await fixture({ exeDev });
    startMemberVm(f.db, { ...f.member, now: f.clock.now() });
    const loop = f.jobs();
    const limited = await drive(f, loop, settled);
    expect(limited.failure).toMatch(/rate_limited/);
    expect(limited.createRequestedAt).toBeNull();
    retryMemberVm(f.db, { ...f.member, now: f.clock.now() });
    const refused = await drive(f, loop, settled);
    expect(refused.step).toBe("create");
    expect(refused.failure).toMatch(/did not create/);
    expect(f.bootstrap.calls).toHaveLength(0);
  });

  test("an ambiguous create error keeps the marker, so the retry's conflict is Paws' own VM", async () => {
    const exeDev = createFakeExeDev();
    const f = await fixture({
      exeDev: {
        ...exeDev,
        async createVm(name) {
          if (!exeDev.vms.has(name)) {
            exeDev.addVm(name);
            throw new ProvisioningError("createVm", "timeout", "exe.dev createVm timed out.");
          }
          return exeDev.createVm(name);
        },
      },
    });
    startMemberVm(f.db, { ...f.member, now: f.clock.now() });
    const loop = f.jobs();
    const timedOut = await drive(f, loop, settled);
    expect(timedOut.failure).toMatch(/timed out/);
    expect(timedOut.createRequestedAt).not.toBeNull();
    retryMemberVm(f.db, { ...f.member, now: f.clock.now() });
    const row = await drive(f, loop, (value) => value.step === "install" || !!value.failure);
    expect(row.failure).toBeNull();
  });

  test("provisioning resolved per claim drives the chain, and a missing prerequisite fails the step", async () => {
    const f = await fixture();
    let ready = false;
    const loop = new JobLoop(f.db, f.clock, { leaseMs: LEASE_MS });
    registerMemberVmJob(loop, {
      provision: () => {
        if (!ready) throw new Error("Create VM needs runner control to be configured.");
        return {
          exeDev: f.exeDev,
          bootstrap: f.bootstrap,
          mintEnrollment: (ref, request) =>
            f.control.createEnrollment({ ...f.member, userId: ref.userId }, request),
        };
      },
      secrets: async () => [EXE_DEV_TOKEN],
      now: () => f.clock.now(),
    });
    startMemberVm(f.db, { ...f.member, now: f.clock.now() });
    const failed = await drive(f, loop, settled);
    expect(failed.step).toBe("create");
    expect(failed.failure).toMatch(/runner control/);
    expect(f.exeDev.calls).toHaveLength(0);
    ready = true;
    retryMemberVm(f.db, { ...f.member, now: f.clock.now() });
    const row = await drive(f, loop, (value) => value.step === "health" || !!value.failure);
    expect(row.failure).toBeNull();
    expect(getRunner(f.db, row.runnerId!)!.ownerUserId).toBe(f.member.userId);
  });

  test("the runner's enroll cause reaches the Runners page", async () => {
    const f = await fixture();
    startMemberVm(f.db, { ...f.member, now: f.clock.now() });
    const loop = f.jobs();
    const cause = "Cause: DNS lookup failed for paws.example.com (ENOTFOUND).";
    f.bootstrap.enroll = async (vm) => {
      throw new BootstrapError(
        "enroll",
        `${vm}: enrollment failed (exit 1): ${RUNNER_FAILURE} ${cause}`,
      );
    };
    const failed = await drive(f, loop, settled);
    expect(failed.step).toBe("enroll");
    expect(failed.failure).toContain(cause);
    const view = memberVmView(failed, f.clock.now());
    expect(view.failure).toContain(cause);
    expect(view.steps.find((step) => step.step === "enroll")?.state).toBe("failed");
  });

  test("a failed step keeps the row and VM, hides secrets, and retry reruns it", async () => {
    const f = await fixture();
    startMemberVm(f.db, { ...f.member, now: f.clock.now() });
    const loop = f.jobs();
    let leaked = "";
    const original = f.bootstrap.startInstall;
    f.bootstrap.startInstall = async (_vm, token) => {
      leaked = token;
      throw new Error(`install broke with ${token} and ${EXE_DEV_TOKEN}`);
    };
    const failed = await drive(f, loop, settled);
    expect(failed.step).toBe("install");
    expect(failed.failure).toContain("install broke");
    expect(failed.failure).not.toContain(leaked);
    expect(failed.failure).not.toContain(EXE_DEV_TOKEN);
    expect(f.exeDev.vms.has(failed.vmName)).toBe(true);
    expect(openJobs(f.db)).toHaveLength(0);
    expect(startMemberVm(f.db, f.member).failure).not.toBeNull();
    expect(openJobs(f.db)).toHaveLength(0);

    f.bootstrap.startInstall = original;
    const retried = retryMemberVm(f.db, { ...f.member, now: f.clock.now() });
    expect(retried.failure).toBeNull();
    expect(retried.step).toBe("install");
    const health = await drive(f, loop, (row) => row.step === "health" || !!row.failure);
    expect(health.failure).toBeNull();
    expect(f.exeDev.calls.filter((call) => call.operation === "createVm")).toHaveLength(1);
  });

  test("a token that expired during a long install is replaced by staging only", async () => {
    const f = await fixture({ installPolls: 200 });
    startMemberVm(f.db, { ...f.member, now: f.clock.now() });
    const row = await drive(f, f.jobs(), (value) => value.step === "health" || !!value.failure);
    expect(row.failure).toBeNull();
    const steps = f.bootstrap.calls.map((call) => call.step);
    expect(steps.filter((step) => step === "startInstall")).toHaveLength(1);
    expect(steps.filter((step) => step === "stageToken")).toHaveLength(1);
    expect(steps.indexOf("stageToken")).toBeLessThan(steps.indexOf("enroll"));
    expect(f.bootstrap.tokens).toHaveLength(2);
    expect(getRunner(f.db, row.runnerId!)!.ownerUserId).toBe(f.member.userId);
  });

  test("a VM that cannot join the tailnet fails before enrollment with a tailnet message", async () => {
    const f = await fixture();
    startMemberVm(f.db, { ...f.member, now: f.clock.now() });
    const loop = f.jobs();
    f.bootstrap.fail("joinTailnet", "tailnet: the VM cannot reach this Paws (exit 2)");
    const failed = await drive(f, loop, settled);
    expect(failed.step).toBe("enroll");
    expect(failed.failure).toContain("tailnet: the VM cannot reach this Paws");
    const steps = f.bootstrap.calls.map((call) => call.step);
    expect(steps.at(-1)).toBe("joinTailnet");
    expect(steps).not.toContain("enroll");
    retryMemberVm(f.db, { ...f.member, now: f.clock.now() });
    const row = await drive(f, loop, (value) => value.step === "health" || !!value.failure);
    expect(row.failure).toBeNull();
    expect(f.bootstrap.calls.filter((call) => call.step === "startInstall")).toHaveLength(1);
  });

  test("a failed enroll restages a fresh token on retry", async () => {
    const f = await fixture();
    startMemberVm(f.db, { ...f.member, now: f.clock.now() });
    const loop = f.jobs();
    f.bootstrap.fail("enroll", "enrollment failed (exit 1)");
    const failed = await drive(f, loop, settled);
    expect(failed.step).toBe("enroll");
    expect(failed.tokenExpiresAt).toBeNull();
    retryMemberVm(f.db, { ...f.member, now: f.clock.now() });
    const row = await drive(f, loop, (value) => value.step === "health" || !!value.failure);
    expect(row.failure).toBeNull();
    expect(f.bootstrap.calls.filter((call) => call.step === "stageToken")).toHaveLength(1);
  });

  test("health fails after ten minutes without a heartbeat, and retry waits again", async () => {
    const f = await fixture();
    startMemberVm(f.db, { ...f.member, now: f.clock.now() });
    const loop = f.jobs();
    const health = await drive(f, loop, (row) => row.step === "health");
    const failed = await drive(f, loop, settled);
    expect(failed.step).toBe("health");
    expect(failed.failure).toMatch(/no heartbeat within ten minutes/);
    expect(f.clock.now() - health.stepStartedAt).toBeGreaterThanOrEqual(10 * 60_000);
    retryMemberVm(f.db, { ...f.member, now: f.clock.now() });
    heartbeat(f.db, failed.runnerId!, f.clock.now());
    expect((await drive(f, loop, settled)).step).toBe("ready");
  });

  test("removing the runner clears runner_id and the next Create VM enrolls the same VM", async () => {
    const f = await fixture();
    startMemberVm(f.db, { ...f.member, now: f.clock.now() });
    const loop = f.jobs();
    const health = await drive(f, loop, (row) => row.step === "health");
    heartbeat(f.db, health.runnerId!, f.clock.now());
    const ready = await drive(f, loop, settled);
    expect(ready.step).toBe("ready");

    f.control.setStatus(f.owner, ready.runnerId!, "revoked");
    expect(findMemberVm(f.db, f.member)!.runnerId).toBeNull();

    const stale = startMemberVm(f.db, { ...f.member, now: f.clock.now() });
    expect(stale.step).toBe("enroll");
    const before = f.bootstrap.calls.length;
    const again = await drive(f, loop, (row) => row.step === "health" || !!row.failure);
    expect(again.failure).toBeNull();
    expect(again.runnerId).not.toBe(ready.runnerId);
    expect(getRunner(f.db, again.runnerId!)!.ownerUserId).toBe(f.member.userId);
    expect(f.exeDev.calls.filter((call) => call.operation === "createVm")).toHaveLength(1);
    expect(f.bootstrap.calls.filter((call) => call.step === "startInstall")).toHaveLength(1);
    expect(f.bootstrap.calls.slice(before).map((call) => call.step)).toEqual([
      "joinTailnet",
      "stageToken",
      "enroll",
      "resetIdentity",
      "stageToken",
      "enroll",
      "startRunner",
    ]);
  });

  test("a VM that keeps a removed runner's identity after a reset fails the enroll step", async () => {
    const f = await fixture();
    startMemberVm(f.db, { ...f.member, now: f.clock.now() });
    const loop = f.jobs();
    const health = await drive(f, loop, (row) => row.step === "health");
    heartbeat(f.db, health.runnerId!, f.clock.now());
    await drive(f, loop, settled);
    f.control.setStatus(f.owner, health.runnerId!, "revoked");
    f.bootstrap.resetIdentity = async () => {};
    startMemberVm(f.db, { ...f.member, now: f.clock.now() });
    const failed = await drive(f, loop, settled);
    expect(failed.step).toBe("enroll");
    expect(failed.failure).toMatch(/kept the identity of a removed runner/);
    expect(failed.runnerId).toBeNull();
  });

  test("a failure that a fake exe.dev raises is stored without the exe.dev token", async () => {
    const exeDev: FakeExeDev = createFakeExeDev();
    exeDev.fail("createVm", "rate_limited");
    const f = await fixture({ exeDev });
    startMemberVm(f.db, { ...f.member, now: f.clock.now() });
    const row = await drive(f, f.jobs(), settled);
    expect(row.step).toBe("create");
    expect(row.failure).toMatch(/rate_limited/);
    retryMemberVm(f.db, { ...f.member, now: f.clock.now() });
    expect((await drive(f, f.jobs(), (value) => value.step !== "create")).step).toBe("install");
  });
});
