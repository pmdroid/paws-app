import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { systemClock } from "../src/core";
import {
  advanceLinearSessionGeneration,
  beginImplementRun,
  bindLinearSessionTask,
  bindOnboardingIntake,
  bindWorkItemRepository,
  insertQueuedItem,
  saveTaskMode,
  type OnboardingAdmission,
  consumeWorkspaceBootstrap,
  ensureLinearSession,
  JobLoop,
  migrate,
  openDatabase,
  putWorkspaceUser,
  readMemberVm,
  recordLinearInstallation,
  syncWorkspaceMember,
} from "../src/db";
import { memberGitHubSecrets } from "../src/credentials";
import { createFakeMemberGitHubClient } from "../src/github";
import { createFakeTracker } from "../src/linear";
import { createMemberVmProvisioner } from "../src/member-vm";
import {
  BootstrapError,
  createFakeExeDev,
  type ExeDev,
  type MemberVmBootstrap,
} from "../src/provisioning";
import { createRunnerControl } from "../src/runner-control";
import { createRunnerHealth } from "../src/runner-health";
import { createRunnerKey, initializeRunnerAuthority } from "../src/runner-identity";
import { signRunnerCommand, verifyRunnerCommand, type RunnerCommand } from "../src/runner-protocol";
import { createRunnerLogin } from "../src/runner-login";
import { createRunnerWork } from "../src/runner-work";
import {
  createWorkspaceAssignments,
  createMemberGitHubAccounts,
  createMemberRepositoryAccess,
  createOnboardingExecution,
  type OnboardingAgents,
  handleOnboardingAgents,
  handleOnboardingVm,
  issueWorkspaceBootstrap,
  issueWorkspaceSession,
  onboardingVmState,
  workspaceTokenHash,
  type WorkspacePrincipal,
} from "../src/workspace";

const ORIGIN = "https://paws.example.invalid";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function deferred() {
  return Promise.withResolvers<void>();
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "paws-member-vm-"));
  roots.push(root);
  const path = join(root, "paws.sqlite");
  const db = openDatabase(path);
  migrate(db);
  const now = Date.now();
  for (const id of ["owner", "member", "other"])
    putWorkspaceUser(db, { id, linearUserId: id, name: id, email: `${id}@example.invalid` });
  consumeWorkspaceBootstrap(db, {
    id: "workspace",
    organizationId: "org",
    name: "Workspace",
    userId: "owner",
    tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(db, "org", now)),
    now,
  });
  for (const id of ["member", "other"])
    syncWorkspaceMember(db, {
      workspaceId: "workspace",
      userId: id,
      role: "member",
      active: true,
      teamIds: ["team"],
      now,
    });
  const assign = (sessionId: string, generation = 0) => {
    const installation = {
      sessionId,
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      teamId: "team",
      observedAtMs: now,
    };
    const spec = {
      linearIssueId: `issue-${sessionId}`,
      identifier: "PAS-1",
      title: "Provision",
      description: "Fixture",
      subIssues: [],
    };
    if (generation === 0) {
      ensureLinearSession(db, {
        sessionId,
        issueId: spec.linearIssueId,
        creatorId: "member",
      });
      recordLinearInstallation(db, installation);
    }
    db.run("INSERT INTO workspace_assignment VALUES(?,?,?,?,?,?,?,?,?)", [
      sessionId,
      generation,
      "workspace",
      "member",
      workspaceTokenHash(`${sessionId}:${generation}`),
      JSON.stringify({ installation, spec }),
      "{}",
      now + 600_000,
      "ready",
    ]);
    return spec;
  };
  const specs = [assign("session")];
  const assignments = createWorkspaceAssignments({
    db,
    onboarding: { provisioningAvailable: () => true },
    origin: ORIGIN,
    clientId: "client",
    memberships: {
      async installation() {
        return { id: "org", name: "Workspace" };
      },
      async member() {
        throw new Error("No membership reads");
      },
    },
    tracker: createFakeTracker(specs),
    lifecycle: {
      async inspect() {
        throw new Error("No dispatch");
      },
      async startCodeIssue() {
        throw new Error("No credentials");
      },
    },
    async accept() {
      throw new Error("No dispatch");
    },
    async continue() {
      throw new Error("No continuation");
    },
  });
  const issuer = join(root, "issuer");
  const authority = await initializeRunnerAuthority(issuer);
  const control = createRunnerControl({
    db,
    authority,
    certificateRoot: issuer,
    disconnect() {},
  });
  const work = createRunnerWork({
    db,
    keyId: "fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
  });
  const login = createRunnerLogin({ db, work });
  const health = createRunnerHealth({ db, work });
  const fake = createFakeExeDev();
  let createHold: Promise<void> | undefined;
  const exeDev: ExeDev = {
    listVms: () => fake.listVms(),
    execVm: (input) => fake.execVm(input),
    async createVm(input) {
      if (createHold) await createHold;
      try {
        return { ...(await fake.createVm(input)), status: "running" };
      } finally {
        const vm = fake.vms.get(input.name);
        if (vm) vm.status = "running";
      }
    },
  };
  const log: string[] = [];
  const guests = new Map<
    string,
    {
      csr?: string;
      pairing?: {
        id: string;
        claim: string;
        code: string;
        requestFingerprint: string;
        expiresAt: number;
      };
      polls: number;
      paired?: string;
    }
  >();
  const guestControl = {
    installResults: [] as ("running" | "succeeded" | "failed")[],
    installHold: undefined as Promise<void> | undefined,
    installFailure: undefined as Error | undefined,
    droppedClaims: 0,
    runnerIds: new Map<string, string>(),
    policies: [] as string[][],
  };
  const guest = (name: string) => {
    const value = guests.get(name) ?? { polls: 0 };
    guests.set(name, value);
    return value;
  };
  const bootstrap: MemberVmBootstrap = {
    async startInstall() {
      log.push("install-start");
      if (guestControl.installHold) await guestControl.installHold;
      if (guestControl.installFailure) throw guestControl.installFailure;
    },
    async installStatus() {
      log.push("install-status");
      return guestControl.installResults.shift() ?? "succeeded";
    },
    async requestPairing(name) {
      log.push("pair-request");
      const state = guest(name);
      state.csr ??= (await createRunnerKey(join(root, `guest-${name}`))).csr;
      if (!state.pairing || state.pairing.expiresAt <= Date.now()) {
        const challenge = await control.beginPairing({ name, csr: state.csr });
        state.pairing = challenge;
        return challenge;
      }
      throw new Error("Fixture guest re-requested an unexpired pairing.");
    },
    async completePairing(name) {
      log.push("pair-complete");
      const state = guest(name);
      if (state.paired) return { phase: "paired", runnerId: state.paired };
      if (!state.pairing || !state.csr) return { phase: "pending" };
      if (state.pairing.expiresAt <= Date.now()) {
        state.pairing = await control.beginPairing({ name, csr: state.csr });
        log.push("pair-renewed");
      }
      const { code, requestFingerprint, expiresAt } = state.pairing;
      const pending = {
        phase: "pending" as const,
        challenge: { code, requestFingerprint, expiresAt },
      };
      if (state.polls++ === 0) return pending;
      const result = control.claimPairing(state.pairing.id, state.pairing.claim);
      if (result.status !== "approved") return pending;
      if (guestControl.droppedClaims > 0) {
        guestControl.droppedClaims--;
        log.push("claim-dropped");
        return pending;
      }
      state.paired = result.runnerId;
      guestControl.runnerIds.set(name, result.runnerId);
      return { phase: "paired", runnerId: result.runnerId };
    },
    async startRunner() {
      log.push("runner-start");
    },
    async allowRepositories(_name, repositories) {
      log.push("policy");
      guestControl.policies.push([...repositories]);
    },
  };
  const provisioner = (database: Database) =>
    createMemberVmProvisioner({
      db: database,
      exeDev,
      bootstrap,
      resources: { cpu: 2, memoryGB: 4 },
      assignments,
      approve: (principal, code, expected) => control.approvePairing(principal, code, expected),
      pollMs: 1,
    });
  const member: WorkspacePrincipal = {
    workspaceId: "workspace",
    userId: "member",
    role: "member",
    teamIds: ["team"],
    authenticatedAt: now,
  };
  const scope = (sessionId = "session", generation = 0) =>
    assignments.onboardingContext(sessionId, generation, member)!;
  const context = (sessionId = "session", generation = 0) => ({
    sessionId,
    generation,
    workspaceId: "workspace",
    linearUserId: "member",
  });
  const sessions = Object.fromEntries(
    ["member", "other"].map((userId) => [
      userId,
      issueWorkspaceSession(db, { workspaceId: "workspace", userId, now }),
    ]),
  );
  const count = (table: string, database = db) =>
    database.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()!.count;
  return {
    root,
    path,
    db,
    fake,
    exeDev,
    log,
    guests,
    guest: guestControl,
    control,
    work,
    login,
    health,
    assignments,
    bootstrap,
    provisioner,
    member,
    scope,
    context,
    sessions,
    count,
    assign: (sessionId: string, generation = 0) => specs.push(assign(sessionId, generation)),
    holdCreate(value: Promise<void> | undefined) {
      createHold = value;
    },
    creates: () => fake.calls.filter((call) => call.operation === "create").length,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function loop(db: Database, provisioner: ReturnType<Fixture["provisioner"]>) {
  const jobs = new JobLoop(db, systemClock, { leaseMs: 60_000 });
  provisioner.register(jobs);
  return jobs;
}

async function drive(jobs: JobLoop, until: () => boolean, each?: () => void, limit = 60) {
  for (let index = 0; index < limit && !until(); index++) {
    each?.();
    await jobs.tick();
    await Bun.sleep(2);
  }
  expect(until()).toBe(true);
}

function agentLogin(f: Fixture, runnerId: string) {
  const session = f.sessions.member!.session;
  return handleOnboardingAgents(
    new Request(`${ORIGIN}/api/workspaces/onboarding/agents/claude/login`, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "x-paws-csrf": session.csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ session: "session", generation: 0, runnerId }),
    }),
    {
      db: f.db,
      assignments: f.assignments,
      dependencies: { login: f.login, health: f.health },
      challenges: new Map(),
      principal: f.member,
      session,
      origin: ORIGIN,
      now: Date.now,
    },
  );
}

function retry(
  f: Fixture,
  body: Record<string, unknown>,
  options: { user?: string; headers?: Record<string, string>; provisioning?: boolean } = {},
) {
  const user = options.user ?? "member";
  const session = f.sessions[user]!.session;
  return handleOnboardingVm(
    new Request(`${ORIGIN}/api/workspaces/onboarding/vm/retry`, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "x-paws-csrf": session.csrfToken,
        "content-type": "application/json",
        ...options.headers,
      },
      body: JSON.stringify(body),
    }),
    {
      db: f.db,
      assignments: f.assignments,
      principal: { ...f.member, userId: user },
      session,
      origin: ORIGIN,
      ...(options.provisioning === false ? {} : { provisioning: f.provisioner(f.db).provisioning }),
    },
  );
}

test("a member VM is created once, installed, paired through the CSR it reported, and healthy before sign-in", async () => {
  const f = await fixture();
  const provisioner = f.provisioner(f.db);
  const jobs = loop(f.db, provisioner);
  expect(onboardingVmState(f.db, f.scope(), Date.now(), true)).toMatchObject({
    state: "provisioning",
    ready: false,
    machine: null,
    retry: null,
    runner: null,
  });
  expect(onboardingVmState(f.db, f.scope(), Date.now(), false)).toMatchObject({
    state: "unavailable",
    steps: [],
  });
  const reserved = provisioner.ensure(f.context())!;
  expect(reserved).toMatchObject({ step: "create", state: "pending", revision: 0 });
  expect(reserved.providerName).toMatch(/^paws-[0-9a-f]{24}$/);
  expect(provisioner.ensure(f.context())!.id).toBe(reserved.id);
  const phases = new Set<string>();
  const vm = () => readMemberVm(f.db, "workspace", "member")!;
  let revision = -1;
  await drive(
    jobs,
    () => vm().step === "ready",
    () => {
      const record = vm();
      phases.add(`${record.step}:${record.state}`);
      const projection = onboardingVmState(f.db, f.scope(), Date.now(), true);
      expect(projection.revision).toBeGreaterThanOrEqual(revision);
      revision = projection.revision;
      expect(projection.ready).toBe(false);
      expect(projection.runner).toBeNull();
      if (record.step === "health" && record.state === "running") {
        f.work.heartbeat(record.runnerId!);
      }
    },
  );
  expect(phases.has("create:pending")).toBe(true);
  expect(phases.has("install:running")).toBe(true);
  expect(phases.has("pair:running")).toBe(true);
  expect(phases.has("health:running")).toBe(true);
  expect(f.creates()).toBe(1);
  expect(f.log).toEqual([
    "install-start",
    "install-status",
    "pair-request",
    "pair-complete",
    "pair-complete",
    "runner-start",
  ]);
  const record = vm();
  expect(record.runnerId).toBe(f.guest.runnerIds.get(record.providerName)!);
  const projection = onboardingVmState(f.db, f.scope(), Date.now(), true);
  expect(projection).toEqual({
    revision: record.revision,
    state: "ready",
    ready: true,
    detail: `Your VM ${record.providerName} is ready.`,
    machine: { name: record.providerName, reused: false },
    steps: [
      { name: "create", state: "done", detail: "VM created." },
      { name: "install", state: "done", detail: "Paws runner installed." },
      { name: "pair", state: "done", detail: "Runner paired with this workspace." },
      { name: "health", state: "done", detail: "Runner reported healthy." },
    ],
    retry: null,
    runner: { id: record.runnerId!, name: record.providerName },
  });
  const progress = f.db
    .query<{ payload: string }, []>("SELECT payload FROM outbox WHERE op='activity' ORDER BY id")
    .all()
    .map((row) => JSON.parse(row.payload).body as string);
  expect(progress).toHaveLength(4);
  const pairing = f.guests.get(record.providerName)!.pairing!;
  for (const body of progress) {
    expect(body).not.toContain(pairing.claim);
    expect(body).not.toContain(record.requestFingerprint!);
    expect(body).not.toContain(record.providerName);
  }
  expect(f.count("runner_login")).toBe(0);
  expect(f.count("runner_command")).toBe(0);
  expect(f.count("member_github_account")).toBe(0);
  f.assign("session-two");
  expect(provisioner.ensure(f.context("session-two"))!.id).toBe(record.id);
  await jobs.tick();
  expect(f.creates()).toBe(1);
  expect(onboardingVmState(f.db, f.scope("session-two"), Date.now(), true)).toMatchObject({
    state: "ready",
    machine: { name: record.providerName, reused: true },
    runner: { id: record.runnerId },
  });
});

test("agent sign-in is refused in every pre-ready phase and permitted only for the healthy provisioned VM", async () => {
  const f = await fixture();
  const provisioner = f.provisioner(f.db);
  const jobs = loop(f.db, provisioner);
  const vm = () => readMemberVm(f.db, "workspace", "member");
  const placeholder = "01AAAAAAAAAAAAAAAAAAAAAAAA";
  const refused = new Set<string>();
  const attempt = async () => {
    const record = vm();
    const response = await agentLogin(f, record?.runnerId ?? placeholder);
    expect(response?.status).not.toBe(200);
    expect(f.count("runner_login")).toBe(0);
    expect(f.count("runner_command")).toBe(0);
    refused.add(record ? `${record.step}:${record.state}` : "none");
  };
  await attempt();
  provisioner.ensure(f.context());
  for (let index = 0; index < 60 && vm()!.step !== "ready"; index++) {
    await attempt();
    const record = vm()!;
    if (record.step === "pair" && record.state === "running" && record.runnerId) {
      const unclaimed = await agentLogin(f, record.runnerId);
      expect(unclaimed?.status).toBe(409);
    }
    if (record.step === "health" && record.state === "running") {
      await attempt();
      f.work.heartbeat(record.runnerId!);
    }
    await jobs.tick();
    await Bun.sleep(2);
  }
  expect([...refused]).toEqual(
    expect.arrayContaining([
      "none",
      "create:pending",
      "install:running",
      "pair:running",
      "health:running",
    ]),
  );
  const ready = vm()!;
  expect(ready.step).toBe("ready");
  const permitted = await agentLogin(f, ready.runnerId!);
  expect(permitted?.status).toBe(200);
  expect(f.count("runner_login")).toBe(1);
  f.db.run("UPDATE runner SET last_seen_at=? WHERE id=?", [Date.now() - 120_000, ready.runnerId]);
  const stale = await agentLogin(f, ready.runnerId!);
  expect(stale?.status).toBe(409);
  const lost = onboardingVmState(f.db, f.scope(), Date.now(), true);
  expect(lost).toMatchObject({ state: "provisioning", ready: false, retry: null, runner: null });
  expect(lost.steps.map((entry) => `${entry.name}:${entry.state}`)).toEqual([
    "create:done",
    "install:done",
    "pair:done",
    "health:running",
  ]);
  await jobs.tick();
  const calls = [...f.log];
  const stableRevision = vm()!.revision;
  expect(provisioner.ensure(f.context())!.step).toBe("ready");
  for (let index = 0; index < 3; index++) await jobs.tick();
  expect(f.log).toEqual(calls);
  expect(f.creates()).toBe(1);
  expect(vm()).toMatchObject({ step: "ready", state: "ready", revision: stableRevision });
  f.work.heartbeat(ready.runnerId!);
  expect(onboardingVmState(f.db, f.scope(), Date.now(), true)).toMatchObject({
    state: "ready",
    ready: true,
    runner: { id: ready.runnerId },
  });
  expect((await agentLogin(f, ready.runnerId!))?.status).toBe(200);
});

test("a lost create response reconciles by listing across a restart and a failed install retries by revision and step without recreating", async () => {
  const f = await fixture();
  f.fake.loseNextCreateResponse = true;
  const provisioner = f.provisioner(f.db);
  const jobs = loop(f.db, provisioner);
  provisioner.ensure(f.context());
  await jobs.tick();
  expect(f.creates()).toBe(1);
  expect(readMemberVm(f.db, "workspace", "member")).toMatchObject({
    step: "create",
    state: "running",
    createOutcome: "unknown",
  });
  const db = openDatabase(f.path);
  const restarted = { ...f, db };
  const second = loop(db, f.provisioner(db));
  f.guest.installResults.push("failed");
  await drive(second, () => readMemberVm(db, "workspace", "member")!.state === "failed");
  expect(f.creates()).toBe(1);
  const failed = readMemberVm(db, "workspace", "member")!;
  expect(failed).toMatchObject({ step: "install", failure: "install", createOutcome: "created" });
  const projection = onboardingVmState(db, f.scope(), Date.now(), true);
  expect(projection).toMatchObject({ state: "failed", ready: false, retry: "install" });
  expect(projection.steps.map((entry) => entry.state)).toEqual([
    "done",
    "failed",
    "waiting",
    "waiting",
  ]);
  const body = { session: "session", generation: 0, revision: failed.revision, step: "install" };
  expect((await retry(restarted, { ...body, revision: failed.revision - 1 }))?.status).toBe(409);
  expect((await retry(restarted, { ...body, step: "create" }))?.status).toBe(409);
  expect((await retry(restarted, { ...body, step: "clone" }))?.status).toBe(400);
  expect((await retry(restarted, { ...body, extra: 1 }))?.status).toBe(400);
  expect((await retry(restarted, body, { headers: { "x-paws-csrf": "wrong" } }))?.status).toBe(403);
  expect(
    (await retry(restarted, body, { headers: { origin: "https://foreign.invalid" } }))?.status,
  ).toBe(403);
  expect((await retry(restarted, body, { user: "other" }))?.status).toBe(404);
  expect((await retry(restarted, { ...body, generation: 1 }))?.status).toBe(404);
  expect((await retry(restarted, body, { provisioning: false }))?.status).toBe(503);
  expect(readMemberVm(db, "workspace", "member")!.revision).toBe(failed.revision);
  const accepted = await retry(restarted, body);
  expect(accepted?.status).toBe(200);
  const next = (await accepted!.json()) as { revision: number; state: string; retry: unknown };
  expect(next.revision).toBeGreaterThan(failed.revision);
  expect(next).toMatchObject({ state: "provisioning", retry: null });
  expect((await retry(restarted, body))?.status).toBe(409);
  await drive(
    second,
    () => readMemberVm(db, "workspace", "member")!.step === "ready",
    () => {
      const record = readMemberVm(db, "workspace", "member")!;
      if (record.step === "health" && record.state === "running")
        f.work.heartbeat(record.runnerId!);
    },
  );
  expect(f.creates()).toBe(1);
  expect(f.log.filter((entry) => entry === "install-start")).toHaveLength(2);
  db.close();
});

test("an initial health timeout fails the health step and its retry keeps the VM, install and pairing", async () => {
  const f = await fixture();
  const provisioner = f.provisioner(f.db);
  const jobs = loop(f.db, provisioner);
  provisioner.ensure(f.context());
  const vm = () => readMemberVm(f.db, "workspace", "member")!;
  await drive(jobs, () => vm().step === "health" && vm().state === "running");
  const runnerId = vm().runnerId!;
  f.db.run("UPDATE member_vm SET step_started_at=? WHERE id=?", [Date.now() - 6 * 60_000, vm().id]);
  await jobs.tick();
  const failed = vm();
  expect(failed).toMatchObject({ step: "health", state: "failed", failure: "runner", runnerId });
  const projection = onboardingVmState(f.db, f.scope(), Date.now(), true);
  expect(projection).toMatchObject({
    state: "failed",
    ready: false,
    retry: "health",
    runner: null,
  });
  expect(projection.steps.map((entry) => entry.state)).toEqual(["done", "done", "done", "failed"]);
  expect((await agentLogin(f, runnerId))?.status).not.toBe(200);
  const calls = f.log.length;
  const accepted = await retry(f, {
    session: "session",
    generation: 0,
    revision: failed.revision,
    step: "health",
  });
  expect(accepted?.status).toBe(200);
  await drive(
    jobs,
    () => vm().step === "ready",
    () => {
      if (vm().step === "health" && vm().state === "running") f.work.heartbeat(runnerId);
    },
  );
  expect(f.log.slice(calls)).toEqual(["runner-start"]);
  expect(f.creates()).toBe(1);
  expect(vm().runnerId).toBe(runnerId);
  expect((await agentLogin(f, runnerId))?.status).toBe(200);
});

test("an existing VM with the reserved name is never adopted and cannot be retried", async () => {
  const f = await fixture();
  const provisioner = f.provisioner(f.db);
  const jobs = loop(f.db, provisioner);
  const record = provisioner.ensure(f.context())!;
  f.fake.vms.set(record.providerName, { name: record.providerName, status: "running" });
  await jobs.tick();
  const failed = readMemberVm(f.db, "workspace", "member")!;
  expect(failed).toMatchObject({ step: "create", state: "failed", failure: "conflict" });
  expect(f.creates()).toBe(0);
  expect(onboardingVmState(f.db, f.scope(), Date.now(), true)).toMatchObject({
    state: "failed",
    retry: null,
  });
  const response = await retry(f, {
    session: "session",
    generation: 0,
    revision: failed.revision,
    step: "create",
  });
  expect(response?.status).toBe(409);
  await jobs.tick();
  expect(f.creates()).toBe(0);
  expect(f.log).toEqual([]);
});

test("concurrent assignments and workers reserve one VM and create it once", async () => {
  const f = await fixture();
  f.assign("session-two");
  const other = openDatabase(f.path);
  const first = f.provisioner(f.db);
  const second = f.provisioner(other);
  const a = first.ensure(f.context())!;
  const b = second.ensure(f.context("session-two"))!;
  expect(b.id).toBe(a.id);
  expect(b.providerName).toBe(a.providerName);
  expect(f.count("member_vm")).toBe(1);
  const hold = deferred();
  f.holdCreate(hold.promise);
  const jobsA = loop(f.db, first);
  const jobsB = loop(other, second);
  const ticks = Promise.all([jobsA.tick(), jobsB.tick()]);
  await Bun.sleep(20);
  hold.resolve();
  const claimed = await ticks;
  expect(claimed.filter((job) => job !== null)).toHaveLength(1);
  f.holdCreate(undefined);
  await jobsB.tick();
  await jobsA.tick();
  expect(f.creates()).toBe(1);
  expect(readMemberVm(f.db, "workspace", "member")!.sessionId).toBe("session");
  other.close();
});

test("Stop, a new generation and member removal fence provider side effects", async () => {
  const stopped = await fixture();
  const provisioner = stopped.provisioner(stopped.db);
  const jobs = loop(stopped.db, provisioner);
  provisioner.ensure(stopped.context());
  const hold = deferred();
  stopped.guest.installHold = hold.promise;
  const tick = jobs.tick();
  for (let index = 0; index < 50 && !stopped.log.includes("install-start"); index++)
    await Bun.sleep(5);
  advanceLinearSessionGeneration(stopped.db, "session", { stop: true });
  hold.resolve();
  await tick;
  expect(readMemberVm(stopped.db, "workspace", "member")).toMatchObject({
    step: "install",
    state: "pending",
  });
  for (let index = 0; index < 5; index++) await jobs.tick();
  expect(stopped.log).toEqual(["install-start"]);
  expect(provisioner.ensure(stopped.context())).toBeNull();
  const retried = await retry(stopped, {
    session: "session",
    generation: 0,
    revision: 0,
    step: "install",
  });
  expect(retried?.status).toBe(404);

  const failing = await fixture();
  const failingProvisioner = failing.provisioner(failing.db);
  const failingJobs = loop(failing.db, failingProvisioner);
  failingProvisioner.ensure(failing.context());
  const failingHold = deferred();
  failing.guest.installHold = failingHold.promise;
  failing.guest.installFailure = new BootstrapError("install", "exit");
  const failingTick = failingJobs.tick();
  for (let index = 0; index < 50 && !failing.log.includes("install-start"); index++)
    await Bun.sleep(5);
  advanceLinearSessionGeneration(failing.db, "session", { stop: true });
  failingHold.resolve();
  await failingTick;
  expect(readMemberVm(failing.db, "workspace", "member")).toMatchObject({
    step: "install",
    state: "pending",
    failure: null,
  });
  expect(
    failing.db
      .query<{ body: string }, []>("SELECT payload AS body FROM outbox WHERE op='activity'")
      .all()
      .map((row) => JSON.parse(row.body).body as string),
  ).toEqual(["Your Paws VM was created. Installing the Paws runner on it."]);
  for (let index = 0; index < 5; index++) await failingJobs.tick();
  expect(failing.log).toEqual(["install-start"]);

  const moved = await fixture();
  const movedProvisioner = moved.provisioner(moved.db);
  const movedJobs = loop(moved.db, movedProvisioner);
  movedProvisioner.ensure(moved.context());
  advanceLinearSessionGeneration(moved.db, "session");
  for (let index = 0; index < 5; index++) await movedJobs.tick();
  expect(moved.fake.calls).toEqual([]);

  const removed = await fixture();
  const removedProvisioner = removed.provisioner(removed.db);
  const removedJobs = loop(removed.db, removedProvisioner);
  removedProvisioner.ensure(removed.context());
  syncWorkspaceMember(removed.db, {
    workspaceId: "workspace",
    userId: "member",
    role: "member",
    active: false,
    teamIds: ["team"],
    now: Date.now() + 1,
  });
  for (let index = 0; index < 5; index++) await removedJobs.tick();
  expect(removed.fake.calls).toEqual([]);
  expect(removedProvisioner.ensure(removed.context())).toBeNull();
});

test("trusted approval accepts only the CSR the provisioned VM reported", async () => {
  const f = await fixture();
  const victim = await createRunnerKey(join(f.root, "victim"));
  const attacker = await createRunnerKey(join(f.root, "attacker"));
  const honest = await f.control.beginPairing({ name: "paws-target", csr: victim.csr });
  const forged = await f.control.beginPairing({ name: "paws-target", csr: attacker.csr });
  let authorized = 0;
  const expected = {
    requestFingerprint: honest.requestFingerprint,
    name: "paws-target",
    authorize: () => {
      authorized++;
    },
  };
  await expect(f.control.approvePairing(f.member, forged.code, expected)).rejects.toThrow();
  await expect(
    f.control.approvePairing(f.member, honest.code, { ...expected, name: "paws-other" }),
  ).rejects.toThrow();
  expect(authorized).toBe(0);
  await expect(
    f.control.approvePairing(f.member, honest.code, {
      ...expected,
      authorize: () => {
        throw new Error("fenced");
      },
    }),
  ).rejects.toThrow();
  expect(f.control.claimPairing(honest.id, honest.claim).status).toBe("pending");
  await f.control.approvePairing(f.member, honest.code, expected);
  expect(authorized).toBe(2);
  expect(f.control.claimPairing(forged.id, forged.claim).status).toBe("pending");
  expect(f.control.claimPairing(honest.id, honest.claim).status).toBe("approved");
});

test("a claim committed by Paws but lost before the guest persisted it is recovered on the same VM after a restart", async () => {
  const f = await fixture();
  f.guest.droppedClaims = 1;
  const provisioner = f.provisioner(f.db);
  const jobs = loop(f.db, provisioner);
  provisioner.ensure(f.context());
  await drive(jobs, () => f.log.includes("claim-dropped"));
  const lost = readMemberVm(f.db, "workspace", "member")!;
  expect(lost).toMatchObject({ step: "pair", state: "running" });
  expect(
    f.db
      .query<{ claimed: number }, []>(
        "SELECT count(*) AS claimed FROM runner_pairing WHERE claimed_at IS NOT NULL",
      )
      .get()!.claimed,
  ).toBe(1);
  expect(f.guests.get(lost.providerName)!.paired).toBeUndefined();
  const db = openDatabase(f.path);
  const restarted = loop(db, f.provisioner(db));
  await drive(
    restarted,
    () => readMemberVm(db, "workspace", "member")!.step === "ready",
    () => {
      const record = readMemberVm(db, "workspace", "member")!;
      if (record.step === "health" && record.state === "running")
        f.work.heartbeat(record.runnerId!);
    },
  );
  const ready = readMemberVm(db, "workspace", "member")!;
  expect(ready.runnerId).toBe(f.guests.get(ready.providerName)!.paired!);
  expect(f.creates()).toBe(1);
  expect(f.log.filter((entry) => entry === "pair-request")).toHaveLength(1);
  expect(f.log.filter((entry) => entry === "install-start")).toHaveLength(1);
  expect(f.count("runner", db)).toBe(1);
  db.close();
});

test("a claim lost until its challenge expired renews pairing on the same VM only for the original CSR", async () => {
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    const f = await fixture();
    f.guest.droppedClaims = 1;
    const provisioner = f.provisioner(f.db);
    const jobs = loop(f.db, provisioner);
    provisioner.ensure(f.context());
    await drive(jobs, () => f.log.includes("claim-dropped"));
    const lost = readMemberVm(f.db, "workspace", "member")!;
    const stale = lost.runnerId!;
    const guest = f.guests.get(lost.providerName)!;
    const original = guest.csr!;
    offset = 11 * 60_000;
    const db = openDatabase(f.path);
    const restarted = loop(db, f.provisioner(db));
    await restarted.tick();
    const failed = readMemberVm(db, "workspace", "member")!;
    expect(failed).toMatchObject({ step: "pair", state: "failed", failure: "pair" });
    const runners = () =>
      db
        .query<{ id: string; status: string }, []>("SELECT id,status FROM runner ORDER BY rowid")
        .all();
    expect(runners()).toEqual([{ id: stale, status: "active" }]);
    expect(
      f.provisioner(db).provisioning.retry({
        sessionId: "session",
        generation: 0,
        principal: f.member,
        revision: failed.revision,
        step: "pair",
      }),
    ).toBe("ok");
    guest.csr = (await createRunnerKey(join(f.root, "foreign-guest"))).csr;
    guest.pairing!.expiresAt = 0;
    await restarted.tick();
    expect(f.log.filter((entry) => entry === "pair-renewed")).toHaveLength(1);
    expect(runners()).toEqual([{ id: stale, status: "active" }]);
    expect(readMemberVm(db, "workspace", "member")).toMatchObject({
      step: "pair",
      state: "running",
      runnerId: stale,
    });
    guest.csr = original;
    guest.pairing!.expiresAt = 0;
    await drive(
      restarted,
      () => readMemberVm(db, "workspace", "member")!.step === "ready",
      () => {
        const record = readMemberVm(db, "workspace", "member")!;
        if (record.step === "health" && record.state === "running")
          f.work.heartbeat(record.runnerId!);
      },
    );
    const ready = readMemberVm(db, "workspace", "member")!;
    expect(ready.runnerId).not.toBe(stale);
    expect(ready.runnerId).toBe(guest.paired!);
    expect(ready.requestFingerprint).toBe(lost.requestFingerprint);
    expect(ready.providerName).toBe(lost.providerName);
    expect(runners()).toEqual([
      { id: stale, status: "revoked" },
      { id: ready.runnerId!, status: "active" },
    ]);
    expect(
      db
        .query<{ count: number }, [string]>(
          "SELECT count(*) AS count FROM runner_certificate WHERE runner_id=? AND revoked_at IS NULL",
        )
        .get(stale)!.count,
    ).toBe(0);
    expect(f.log.filter((entry) => entry === "pair-request")).toHaveLength(1);
    expect(f.log.filter((entry) => entry === "install-start")).toHaveLength(1);
    expect(f.creates()).toBe(1);
    db.close();
  } finally {
    Date.now = realNow;
  }
});

test("a failure from a request held for a stopped assignment cannot fail the rebound assignment", async () => {
  const f = await fixture();
  f.assign("session-two");
  const provisioner = f.provisioner(f.db);
  const jobs = loop(f.db, provisioner);
  provisioner.ensure(f.context());
  const hold = deferred();
  f.guest.installHold = hold.promise;
  f.guest.installFailure = new BootstrapError("install", "exit");
  const tick = jobs.tick();
  for (let index = 0; index < 50 && !f.log.includes("install-start"); index++) await Bun.sleep(5);
  advanceLinearSessionGeneration(f.db, "session", { stop: true });
  const rebound = provisioner.ensure(f.context("session-two"))!;
  expect(rebound).toMatchObject({ sessionId: "session-two", generation: 0, step: "install" });
  hold.resolve();
  await tick;
  const after = readMemberVm(f.db, "workspace", "member")!;
  expect(after).toMatchObject({
    sessionId: "session-two",
    step: "install",
    state: "pending",
    failure: null,
    run: rebound.run,
  });
  expect(
    f.db
      .query<{ body: string }, []>("SELECT payload AS body FROM outbox WHERE op='activity'")
      .all()
      .map((row) => JSON.parse(row.body).body as string),
  ).not.toContain("Setting up your Paws VM stopped. You can retry from the onboarding page.");
  f.guest.installHold = undefined;
  f.guest.installFailure = undefined;
  await drive(
    jobs,
    () => readMemberVm(f.db, "workspace", "member")!.step === "ready",
    () => {
      const record = readMemberVm(f.db, "workspace", "member")!;
      if (record.step === "health" && record.state === "running")
        f.work.heartbeat(record.runnerId!);
    },
  );
  expect(readMemberVm(f.db, "workspace", "member")!.sessionId).toBe("session-two");
  expect(f.creates()).toBe(1);
});

test("a restart after health was recorded running but before the daemon start resumes the start without a retry", async () => {
  const f = await fixture();
  const provisioner = f.provisioner(f.db);
  const jobs = loop(f.db, provisioner);
  provisioner.ensure(f.context());
  await drive(jobs, () => readMemberVm(f.db, "workspace", "member")!.step === "health");
  const starts = () => f.log.filter((entry) => entry === "runner-start").length;
  const before = starts();
  const record = readMemberVm(f.db, "workspace", "member")!;
  f.db.run(
    "UPDATE member_vm SET state='running',step_started_at=?,runner_started=0,revision=revision+1 WHERE id=?",
    [Date.now(), record.id],
  );
  const db = openDatabase(f.path);
  const restarted = loop(db, f.provisioner(db));
  await restarted.tick();
  expect(starts()).toBe(before + 1);
  expect(readMemberVm(db, "workspace", "member")).toMatchObject({
    step: "health",
    state: "running",
    runnerStarted: true,
  });
  await restarted.tick();
  expect(starts()).toBe(before + 1);
  f.work.heartbeat(record.runnerId!);
  await drive(restarted, () => readMemberVm(db, "workspace", "member")!.step === "ready");
  expect(starts()).toBe(before + 1);
  expect(readMemberVm(db, "workspace", "member")!.revision).toBeGreaterThan(record.revision);
  db.close();
});

test("the boot interval after creation waits for the VM without claiming the install is running", async () => {
  const f = await fixture();
  const provisioner = f.provisioner(f.db);
  const jobs = loop(f.db, provisioner);
  let booted = false;
  f.exeDev.listVms = async () =>
    (await f.fake.listVms()).map((vm) => ({ ...vm, status: booted ? "running" : "starting" }));
  f.exeDev.createVm = async (input) => ({ ...(await f.fake.createVm(input)), status: "starting" });
  provisioner.ensure(f.context());
  await jobs.tick();
  await jobs.tick();
  expect(readMemberVm(f.db, "workspace", "member")).toMatchObject({
    step: "install",
    state: "pending",
    createOutcome: "created",
  });
  expect(f.log).toEqual([]);
  const waiting = onboardingVmState(f.db, f.scope(), Date.now(), true);
  expect(waiting).toMatchObject({ state: "provisioning", detail: "Waiting for your VM to boot." });
  expect(waiting.steps.map((entry) => [entry.name, entry.state, entry.detail])).toEqual([
    ["create", "done", "VM created."],
    ["install", "waiting", "Waiting for your VM to boot."],
    ["pair", "waiting", ""],
    ["health", "waiting", ""],
  ]);
  booted = true;
  await drive(jobs, () => f.log.includes("install-start"));
  expect(f.log).toEqual(["install-start"]);
  const installing = onboardingVmState(f.db, f.scope(), Date.now(), true);
  expect(installing.steps[1]).toEqual({
    name: "install",
    state: "running",
    detail: "Installing tools and the Paws runner.",
  });
});

async function readyPolicyFixture() {
  const f = await fixture();
  const provisioner = f.provisioner(f.db);
  const jobs = loop(f.db, provisioner);
  provisioner.ensure(f.context());
  await drive(
    jobs,
    () => readMemberVm(f.db, "workspace", "member")!.step === "ready",
    () => {
      const record = readMemberVm(f.db, "workspace", "member")!;
      if (record.step === "health" && record.state === "running")
        f.work.heartbeat(record.runnerId!);
    },
  );
  const record = readMemberVm(f.db, "workspace", "member")!;
  f.db.run("INSERT INTO workspace_repository VALUES(?,?,?)", ["workspace", "acme/app", "team"]);
  const prepare = (sessionId: string, repository: string) => {
    const [owner, repo] = repository.split("/");
    f.db.run(
      `INSERT INTO onboarding_preparation(session_id,generation,revision,scope,mode,repository_context,repository,offered,updated_at)
      VALUES(?,0,1,'fixture','code',1,?,'[]',?) ON CONFLICT(session_id,generation) DO UPDATE SET repository=excluded.repository`,
      [
        sessionId,
        JSON.stringify({ owner, repo, remoteUrl: `https://github.com/${repository}.git` }),
        Date.now(),
      ],
    );
  };
  prepare("session", "acme/app");
  f.db.run(
    "INSERT INTO member_github_account(workspace_id,user_id,github_id,login,secret_id,revision) VALUES('workspace','member',1,'fixture','secret',1)",
  );
  const input = {
    sessionId: "session",
    generation: 0,
    workspaceId: "workspace",
    userId: "member",
    runnerId: record.runnerId!,
    repository: "acme/app",
    current: () => true,
  };
  return { ...f, record, prepare, input, policy: provisioner, jobs };
}

test("exact live assignment grants wait for applied policy and revoke across a provisioner restart", async () => {
  const f = await readyPolicyFixture();
  const { policy, input, jobs, record } = f;
  const signal = new AbortController().signal;
  expect(await policy.allowRepository({ ...input, current: () => false }, signal)).toBe(false);
  expect(
    await policy.allowRepository({ ...input, runnerId: "01AAAAAAAAAAAAAAAAAAAAAAAA" }, signal),
  ).toBe(false);
  expect(await policy.allowRepository(input, signal)).toBe(false);
  await drive(jobs, () => readMemberVm(f.db, "workspace", "member")!.policyAppliedRevision === 1);
  expect(await policy.allowRepository(input, signal)).toBe(true);
  const recordAfter = readMemberVm(f.db, "workspace", "member")!;
  expect(recordAfter.repositories).toEqual(["acme/app"]);
  const keys = generateKeyPairSync("ed25519");
  const command = (owner: string, repo: string, id: string): RunnerCommand => ({
    id,
    type: "run",
    runnerId: record.runnerId!,
    workspaceId: "workspace",
    issuedAt: 1000,
    expiresAt: 2000,
    runId: "run",
    itemId: "item",
    generation: 1,
    repository: {
      owner,
      repo,
      remoteUrl: `https://github.com/${owner}/${repo}.git`,
      baseSha: "a".repeat(40),
    },
    profile: { agent: "claude", model: null },
    prompt: "Work on the authorized repository.",
  });
  const claimed = new Set<string>();
  const verify = (signed: RunnerCommand) =>
    verifyRunnerCommand(
      signRunnerCommand({ keyId: "control", privateKey: keys.privateKey, command: signed }),
      {
        trustedKeys: new Map([["control", keys.publicKey]]),
        runnerId: record.runnerId!,
        workspaceId: "workspace",
        now: 1500,
        allowedRepositories: recordAfter.repositories,
        claimCommand: (id) => !claimed.has(id) && Boolean(claimed.add(id)),
      },
    );
  expect(verify(command("acme", "app", "allowed")).ok).toBe(true);
  expect(verify(command("acme", "other", "denied"))).toEqual({
    ok: false,
    reason: "repository_denied",
    repository: "acme/other",
  });
  advanceLinearSessionGeneration(f.db, "session", { stop: true });
  const db = openDatabase(f.path);
  const restarted = loop(db, f.provisioner(db));
  await drive(
    restarted,
    () => readMemberVm(db, "workspace", "member")!.policyAppliedRevision === 2,
  );
  expect(readMemberVm(db, "workspace", "member")!.repositories).toEqual([]);
  expect(f.guest.policies.at(-1)).toEqual([]);
  db.close();
});

test("authority loss after guest publication fails the final CAS and restart reconciles the stale guest", async () => {
  const f = await readyPolicyFixture();
  const signal = new AbortController().signal;
  expect(await f.policy.allowRepository(f.input, signal)).toBe(false);
  const entered = deferred();
  const release = deferred();
  let guest: string[] = [];
  const bootstrap = f.bootstrap;
  const original = bootstrap.allowRepositories;
  bootstrap.allowRepositories = async (_name, repositories) => {
    guest = [...repositories];
    entered.resolve();
    await release.promise;
  };
  const pending = f.jobs.tick();
  await entered.promise;
  advanceLinearSessionGeneration(f.db, "session", { stop: true });
  release.resolve();
  await pending;
  expect(guest).toEqual(["acme/app"]);
  expect(readMemberVm(f.db, "workspace", "member")).toMatchObject({
    repositories: [],
    policyRevision: 2,
    policyAppliedRevision: -1,
  });
  bootstrap.allowRepositories = async (_name, repositories, policy) => {
    guest = [...repositories];
    await original(_name, repositories, policy);
  };
  const db = openDatabase(f.path);
  const restarted = loop(db, f.provisioner(db));
  await drive(
    restarted,
    () => readMemberVm(db, "workspace", "member")!.policyAppliedRevision === 2,
  );
  expect(guest).toEqual([]);
  db.close();
});

test("independent SQLite workers serialize desired unions and fence a late guest publication", async () => {
  const f = await readyPolicyFixture();
  f.assign("session-two");
  f.db.run("INSERT INTO workspace_repository VALUES(?,?,?)", ["workspace", "acme/second", "team"]);
  f.prepare("session-two", "acme/second");
  const db = openDatabase(f.path);
  const second = f.provisioner(db);
  const otherJobs = loop(db, second);
  const signal = new AbortController().signal;
  expect(await f.policy.allowRepository(f.input, signal)).toBe(false);
  const entered = deferred();
  const release = deferred();
  let guest = { fence: 0, repositories: [] as string[] };
  f.bootstrap.allowRepositories = async (_name, repositories, policy) => {
    if (policy.fence === 1) {
      entered.resolve();
      await release.promise;
    }
    if (policy.fence < guest.fence) throw new BootstrapError("policy", "exit");
    guest = { fence: policy.fence, repositories: [...repositories] };
  };
  const pending = f.jobs.tick();
  await entered.promise;
  expect(
    await second.allowRepository(
      { ...f.input, sessionId: "session-two", repository: "acme/second" },
      signal,
    ),
  ).toBe(false);
  expect(await otherJobs.tick()).toBeNull();
  db.run("UPDATE job SET locked_until=0 WHERE queue='member.vm.provision'");
  await otherJobs.tick();
  expect(guest.repositories).toEqual(["acme/app", "acme/second"]);
  release.resolve();
  await pending;
  expect(readMemberVm(db, "workspace", "member")).toMatchObject({
    repositories: guest.repositories,
    policyAppliedRevision: 2,
    policyAppliedFence: guest.fence,
  });
  expect(await second.allowRepository(f.input, signal)).toBe(true);
  db.close();
});

for (const loss of ["membership", "github", "scope", "denied", "unknown_write"] as const) {
  test(`durable repository policy reconciles ${loss} while independent credentials stay gated`, async () => {
    const f = await readyPolicyFixture();
    const signal = new AbortController().signal;
    expect(await f.policy.allowRepository(f.input, signal)).toBe(false);
    await drive(
      f.jobs,
      () => readMemberVm(f.db, "workspace", "member")!.policyAppliedRevision === 1,
    );
    expect(await f.policy.allowRepository(f.input, signal)).toBe(true);
    if (loss === "membership")
      f.db.run(
        "UPDATE workspace_member SET active=0 WHERE workspace_id='workspace' AND user_id='member'",
      );
    if (loss === "github")
      f.db.run(
        "UPDATE member_github_account SET revoked=1,revision=revision+1 WHERE workspace_id='workspace' AND user_id='member'",
      );
    if (loss === "scope")
      f.db.run("DELETE FROM workspace_repository WHERE workspace_id='workspace'");
    if (loss === "denied")
      expect(await f.policy.allowRepository({ ...f.input, authorized: false }, signal)).toBe(false);
    if (loss === "unknown_write") {
      f.assign("session-two");
      f.db.run("INSERT INTO workspace_repository VALUES(?,?,?)", [
        "workspace",
        "acme/second",
        "team",
      ]);
      f.prepare("session-two", "acme/second");
      expect(
        await f.policy.allowRepository(
          { ...f.input, sessionId: "session-two", repository: "acme/second" },
          signal,
        ),
      ).toBe(false);
      const publish = f.bootstrap.allowRepositories;
      f.bootstrap.allowRepositories = async (name, repositories, policy) => {
        await publish(name, repositories, policy);
        throw new BootstrapError("policy", "output");
      };
      await Bun.sleep(2);
      await f.jobs.tick();
      expect(readMemberVm(f.db, "workspace", "member")!.policyAppliedRevision).toBe(1);
      f.bootstrap.allowRepositories = publish;
    }
    const db = openDatabase(f.path);
    db.run("UPDATE job SET run_at=0 WHERE queue='member.vm.provision'");
    const restarted = loop(db, f.provisioner(db));
    await drive(
      restarted,
      () => readMemberVm(db, "workspace", "member")!.policyAppliedRevision === 2,
    );
    expect(readMemberVm(db, "workspace", "member")!.repositories).toEqual(
      loss === "unknown_write" ? ["acme/app", "acme/second"] : [],
    );
    expect(f.count("runner_command")).toBe(0);
    db.close();
  });
}

for (const observation of [
  "denied",
  "during_mint",
  "owner_changed",
  "runner_fenced",
  "newer_grant",
  "newer_runtime",
  "provider_outage",
  "ready_after_withdraw",
] as const) {
  test(`continued assignment runtime ${observation} withdrawal is durable and scoped to current ownership`, async () => {
    const f = await readyPolicyFixture();
    const signal = new AbortController().signal;
    const secretsDir = join(f.root, "secrets");
    const secret = memberGitHubSecrets(secretsDir, "workspace", "member").write("fixture-token");
    f.db.run("UPDATE member_github_account SET secret_id=?", [secret]);
    const client = createFakeMemberGitHubClient();
    client.account = { id: 1, login: "fixture" };
    const providerRepository = client.repository;
    let providerUnavailable = false;
    client.repository = async function (...args) {
      if (providerUnavailable) throw new Error("Fixture provider outage");
      return providerRepository.apply(this, args);
    };
    const accounts = createMemberGitHubAccounts({ db: f.db, secretsDir, client });
    const access = createMemberRepositoryAccess({
      db: f.db,
      clientId: "client",
      accounts,
      memberships: {
        async member(organizationId, userId) {
          return {
            organizationId,
            userId,
            active: true,
            guest: false,
            admin: false,
            teamIds: ["team"],
          };
        },
      },
    });
    const item = insertQueuedItem(f.db, {
      id: "runtime-item",
      now: Date.now(),
      sessionKey: "session",
    });
    f.db.run("UPDATE work_item SET linear_issue_id='issue-session' WHERE id=?", [item.id]);
    bindLinearSessionTask(f.db, "session", item.delegationId, { actorId: "member" });
    beginImplementRun(f.db, item.id, Date.now());
    const repository = { owner: "acme", repo: "app", remoteUrl: "https://github.com/acme/app.git" };
    bindWorkItemRepository(f.db, item.id, repository);
    saveTaskMode(f.db, item.id, "code", 0, true);
    expect((await access.check(item.id, signal)).state).toBe("ready");
    await f.policy.allowRepository(f.input, signal);
    await drive(
      f.jobs,
      () => readMemberVm(f.db, "workspace", "member")!.policyAppliedRevision === 1,
    );
    const admission: OnboardingAdmission = {
      sessionId: "session",
      generation: 0,
      workspaceId: "workspace",
      userId: "member",
      linearUserId: "member",
      issueId: "issue-session",
      issueFingerprint: JSON.stringify(f.scope().issue),
      revision: 1,
      fingerprint: "runtime-test",
      mode: "code",
      repositoryContext: true,
      repository,
      permission: "push",
      runnerId: f.input.runnerId,
      runnerFence: 0,
    };
    f.db.run(
      "INSERT INTO onboarding_readiness VALUES('session',0,1,'runtime-test','runtime-test','{}',?)",
      [Date.now() + 60000],
    );
    bindOnboardingIntake(
      f.db,
      admission,
      [{ id: item.id, linearIssueId: "issue-session" }],
      () => {},
    );
    f.db.run("UPDATE workspace_assignment SET status='continued' WHERE session_id='session'");
    const checkedAt = Date.now();
    const agents: OnboardingAgents = {
      login: {
        list: () => ({
          accounts: (["claude", "codex"] as const).map((agent) => ({
            agent,
            connected: true,
            updatedAt: checkedAt,
            session: null,
          })),
        }),
        start: () => {
          throw new Error("No login");
        },
        browser: () => {
          throw new Error("No browser");
        },
      },
      health: {
        agents: () =>
          (["claude", "codex"] as const).map((agent) => ({
            agent,
            status: "signed_in" as const,
            checkedAt,
          })),
      },
    };
    const execution = createOnboardingExecution({
      db: f.db,
      assignments: f.assignments,
      access: {
        async check(itemId, currentSignal) {
          const result = await access.check(itemId, currentSignal);
          if (observation === "ready_after_withdraw") {
            const secondDb = openDatabase(f.path);
            const deny = createOnboardingExecution({
              db: secondDb,
              assignments: f.assignments,
              agents,
              access: {
                async check() {
                  return { ...result, state: "denied" as const, reason: "permission" as const };
                },
              },
            });
            await expect(
              deny.authorizeRepository(
                itemId,
                repository,
                "write",
                currentSignal,
                async () => "forbidden",
              ),
            ).rejects.toThrow();
            secondDb.close();
          }
          if (observation === "newer_runtime") {
            client.allowed = true;
            const secondDb = openDatabase(f.path);
            const secondAccess = createMemberRepositoryAccess({
              db: secondDb,
              clientId: "client",
              accounts: createMemberGitHubAccounts({ db: secondDb, secretsDir, client }),
              memberships: {
                async member(organizationId, userId) {
                  return {
                    organizationId,
                    userId,
                    active: true,
                    guest: false,
                    admin: false,
                    teamIds: ["team"],
                  };
                },
              },
            });
            let freshChecks = 0;
            const newer = createOnboardingExecution({
              db: secondDb,
              assignments: f.assignments,
              agents,
              access: {
                async check(id, newerSignal) {
                  freshChecks++;
                  return secondAccess.check(id, newerSignal);
                },
              },
            });
            expect(
              await newer.authorizeRepository(
                itemId,
                repository,
                "write",
                currentSignal,
                async () => "newer-token",
              ),
            ).toBe("newer-token");
            expect(freshChecks).toBe(2);
            secondDb.close();
          }
          if (observation === "newer_grant") {
            client.allowed = true;
            expect((await access.check(itemId, currentSignal)).state).toBe("ready");
            await f.policy.allowRepository(f.input, currentSignal);
          }
          if (observation === "owner_changed")
            f.db.run("UPDATE work_item SET owner_user_id='other' WHERE id=?", [itemId]);
          if (observation === "runner_fenced")
            f.db.run("UPDATE runner SET fence=fence+1 WHERE id=?", [f.input.runnerId]);
          return result;
        },
      },
      agents,
    });
    providerUnavailable = observation === "provider_outage";
    client.allowed = observation === "during_mint" || observation === "ready_after_withdraw";
    if (observation === "ready_after_withdraw") {
      expect(
        await execution.authorizeRepository(
          item.id,
          repository,
          "write",
          signal,
          async () => "authorized-token",
        ),
      ).toBe("authorized-token");
      expect(f.db.query("SELECT repository FROM member_vm_repository_grant").all()).toEqual([]);
      return;
    }
    let mints = 0;
    await expect(
      execution.authorizeRepository(item.id, repository, "write", signal, async () => {
        mints++;
        client.allowed = false;
        return "fixture-app-token";
      }),
    ).rejects.toThrow();
    expect(mints).toBe(observation === "during_mint" ? 1 : 0);
    if (
      observation === "owner_changed" ||
      observation === "runner_fenced" ||
      observation === "newer_grant" ||
      observation === "newer_runtime" ||
      observation === "provider_outage"
    ) {
      expect(f.db.query("SELECT repository FROM member_vm_repository_grant").all()).toEqual([
        { repository: "acme/app" },
      ]);
      return;
    }
    expect(f.db.query("SELECT repository FROM member_vm_repository_grant").all()).toEqual([]);
    const db = openDatabase(f.path);
    const restarted = loop(db, f.provisioner(db));
    await drive(
      restarted,
      () => readMemberVm(db, "workspace", "member")!.policyAppliedRevision === 2,
    );
    expect(f.guest.policies.at(-1)).toEqual([]);
    client.allowed = true;
    await restarted.tick();
    expect(readMemberVm(db, "workspace", "member")!.repositories).toEqual([]);
    expect((await access.check(item.id, signal)).state).toBe("ready");
    expect(await f.policy.allowRepository(f.input, signal)).toBe(false);
    await drive(
      restarted,
      () => readMemberVm(db, "workspace", "member")!.policyAppliedRevision === 3,
    );
    expect(f.guest.policies.at(-1)).toEqual(["acme/app"]);
    expect(await f.policy.allowRepository(f.input, signal)).toBe(true);
    db.close();
  });
}
