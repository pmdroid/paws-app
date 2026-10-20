import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  armMemberVmJob,
  auditWorkspaceAccess,
  claimedMemberRunner,
  disarmMemberVmJob,
  enqueueOutboxOnce,
  findRunnerPairing,
  getRunner,
  immediate,
  MEMBER_VM_QUEUE,
  memberRunnerHeartbeat,
  readMemberVm,
  readMemberVmById,
  reserveMemberVm,
  runnerPairingByFingerprint,
  updateMemberVm,
  updateRunnerStatus,
  workspaceLinearMember,
  memberGitHubRecord,
  teamRepositoryAllowedSql,
  workspaceMember,
  type Job,
  type JobContext,
  type JobLoop,
  type MemberVmChanges,
  type MemberVmRecord,
} from "../db";
import {
  BootstrapError,
  guestRepositoryList,
  ProvisioningError,
  type CreateVm,
  type ExeDev,
  type MemberVmBootstrap,
  type PairingChallenge,
  type Vm,
} from "../provisioning";
import {
  PERMANENT_VM_FAILURES,
  workspaceTokenHash,
  type OnboardingVmProvisioning,
  type WorkspaceAssignments,
  type WorkspacePrincipal,
} from "../workspace";

export type MemberVmApproval = (
  principal: WorkspacePrincipal,
  code: string,
  expected: { requestFingerprint: string; name: string; authorize(): void },
) => Promise<unknown>;

export type MemberVmProvisionerOptions = {
  db: Database;
  exeDev: ExeDev;
  bootstrap: MemberVmBootstrap;
  resources: Omit<CreateVm, "name">;
  assignments: Pick<WorkspaceAssignments, "onboardingContext">;
  approve: MemberVmApproval;
  now?: () => number;
  pollMs?: number;
  createWaitMs?: number;
  installTimeoutMs?: number;
  pairTimeoutMs?: number;
  healthTimeoutMs?: number;
};

export type MemberVmAssignment = {
  sessionId: string;
  generation: number;
  workspaceId: string;
  linearUserId: string;
};

export type MemberVmRepositoryPolicy = {
  sessionId: string;
  generation: number;
  workspaceId: string;
  userId: string;
  runnerId: string;
  repository: string;
  authorized?: boolean;
  current: () => boolean;
};

type Scope = { sessionId: string; generation: number; workspaceId: string; userId: string };

class Fenced extends Error {}

class StepFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const PROGRESS: Record<string, string> = {
  install: "Your Paws VM was created. Installing the Paws runner on it.",
  pair: "The Paws runner is installed. Pairing your VM with this workspace.",
  health: "Your VM is paired. Starting the runner and waiting for it to report healthy.",
  ready: "Your Paws VM is ready. Sign in to Claude and Codex from the onboarding page to continue.",
  failed: "Setting up your Paws VM stopped. You can retry from the onboarding page.",
};

function failureCode(error: unknown, step: string): string {
  if (error instanceof StepFailure) return error.code;
  if (error instanceof ProvisioningError) {
    if (error.code === "credentials") return "credentials";
    if (error.code === "timeout") return "timeout";
    return error.outcome === "rejected" ? "rejected" : "provider";
  }
  if (error instanceof BootstrapError) return error.operation;
  return step === "health" ? "runner" : step === "create" ? "provider" : step;
}

function summary(vm: Vm) {
  return { name: vm.name, ...(vm.status ? { status: vm.status } : {}) };
}

export function createMemberVmProvisioner(options: MemberVmProvisionerOptions) {
  const { db } = options;
  const now = options.now ?? Date.now;
  const pollMs = options.pollMs ?? 5_000;
  const createWaitMs = options.createWaitMs ?? 120_000;
  const installTimeoutMs = options.installTimeoutMs ?? 20 * 60_000;
  const pairTimeoutMs = options.pairTimeoutMs ?? 9 * 60_000;
  const healthTimeoutMs = options.healthTimeoutMs ?? 5 * 60_000;

  function authority(record: MemberVmRecord) {
    if (record.sessionId === null || record.generation === null) return null;
    const member = workspaceMember(db, record.workspaceId, record.userId);
    if (!member?.active || member.role === "observer") return null;
    const principal: WorkspacePrincipal = {
      workspaceId: member.workspaceId,
      userId: member.userId,
      role: member.role,
      teamIds: member.teamIds,
      authenticatedAt: now(),
    };
    const scope = options.assignments.onboardingContext(
      record.sessionId,
      record.generation,
      principal,
    );
    if (!scope || scope.workspaceId !== record.workspaceId || scope.userId !== record.userId)
      return null;
    return { principal, scope };
  }

  function progress(record: MemberVmRecord, key: string) {
    if (record.sessionId === null || record.generation === null) return;
    enqueueOutboxOnce(db, {
      target: "linear",
      op: "activity",
      orderingKey: record.sessionId,
      idempotencyKey: `member-vm:${record.id}:${record.run}:${key}`,
      generation: record.generation,
      payload: { sessionId: record.sessionId, kind: "thought", body: PROGRESS[key] },
      now: now(),
    });
  }

  function memberScope(assignment: MemberVmAssignment) {
    const member = workspaceLinearMember(db, assignment.workspaceId, assignment.linearUserId);
    if (!member?.active || member.role === "observer") return null;
    return options.assignments.onboardingContext(assignment.sessionId, assignment.generation, {
      workspaceId: member.workspaceId,
      userId: member.userId,
      role: member.role,
      teamIds: member.teamIds,
      authenticatedAt: now(),
    });
  }

  function start(scope: Scope) {
    const salt = randomBytes(16).toString("hex");
    const digest = createHash("sha256")
      .update(`${scope.workspaceId}\0${scope.userId}\0${salt}`)
      .digest("hex");
    const record = reserveMemberVm(db, {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      userId: scope.userId,
      providerName: `paws-${digest.slice(0, 24)}`,
      sessionId: scope.sessionId,
      generation: scope.generation,
      now: now(),
    });
    if (
      (record.sessionId !== scope.sessionId || record.generation !== scope.generation) &&
      !authority(record)
    )
      updateMemberVm(
        db,
        record.id,
        record.run,
        { sessionId: scope.sessionId, generation: scope.generation },
        now(),
      );
    if (record.state !== "failed") armMemberVmJob(db, record.id, pollMs, now());
    return readMemberVmById(db, record.id);
  }

  async function tick(job: Job, context: JobContext) {
    const id = (job.payload as { id?: unknown }).id;
    const stop = () => {
      if (!context.isCurrent()) return;
      disarmMemberVmJob(db, job.id, job.lockedBy);
      job.recurringEveryMs = null;
    };
    const first = typeof id === "string" ? readMemberVmById(db, id) : null;
    if (!first || first.state === "failed") return stop();
    if (first.step === "ready") {
      await reconcilePolicy(first, context);
      return;
    }
    const live = () => {
      if (!context.isCurrent()) throw new Fenced();
      const record = readMemberVmById(db, first.id);
      if (
        !record ||
        record.run !== first.run ||
        record.sessionId !== first.sessionId ||
        record.generation !== first.generation
      )
        throw new Fenced();
      const granted = authority(record);
      if (!granted) throw new Fenced();
      return { record, ...granted };
    };
    const save = (changes: MemberVmChanges, announce?: string) =>
      immediate(db, () => {
        const { record } = live();
        if (!updateMemberVm(db, record.id, record.run, changes, now())) throw new Fenced();
        if (announce) progress(record, announce);
        return readMemberVmById(db, record.id)!;
      });
    const expired = (record: MemberVmRecord, limit: number) =>
      record.stepStartedAt !== null && now() - record.stepStartedAt > limit;
    const installed = (vm: Vm): MemberVmChanges => ({
      vm: summary(vm),
      createOutcome: "created",
      step: "install",
      state: "pending",
      stepStartedAt: null,
    });

    async function create(record: MemberVmRecord): Promise<boolean> {
      const vms = await options.exeDev.listVms();
      live();
      const found = vms.find((vm) => vm.name === record.providerName);
      if (found) {
        if (record.createOutcome === "none") throw new StepFailure("conflict");
        save(installed(found), "install");
        return true;
      }
      if (record.createOutcome === "unknown" && record.createRun === record.run) {
        if (expired(record, createWaitMs)) throw new StepFailure("unresolved");
        return false;
      }
      if (record.createOutcome === "created") throw new StepFailure("missing");
      const sent = record.createOutcome === "unknown";
      save({
        createOutcome: "unknown",
        createRun: record.run,
        state: "running",
        stepStartedAt: now(),
      });
      let vm: Vm;
      try {
        vm = await options.exeDev.createVm({ ...options.resources, name: record.providerName });
      } catch (error) {
        if (error instanceof ProvisioningError && error.outcome !== "unknown") {
          if (!sent) save({ createOutcome: "none" });
          throw error;
        }
        return false;
      }
      live();
      save(installed(vm), "install");
      return true;
    }

    async function install(record: MemberVmRecord): Promise<boolean> {
      const name = record.providerName;
      if (record.state !== "running") {
        const vm = (await options.exeDev.listVms()).find((entry) => entry.name === name);
        live();
        if (!vm) throw new StepFailure("missing");
        if (vm.status !== "running") {
          if (record.stepStartedAt === null) save({ stepStartedAt: now(), vm: summary(vm) });
          else if (expired(record, createWaitMs)) throw new StepFailure("timeout");
          else if (record.vm?.status !== vm.status) save({ vm: summary(vm) });
          return false;
        }
        await options.bootstrap.startInstall(name);
        live();
        save({ state: "running", stepStartedAt: now(), vm: summary(vm) });
        return false;
      }
      const status = await options.bootstrap.installStatus(name);
      live();
      if (status === "failed") throw new StepFailure("install");
      if (status === "running") {
        if (expired(record, installTimeoutMs)) throw new StepFailure("timeout");
        return false;
      }
      save({ step: "pair", state: "pending", stepStartedAt: null }, "pair");
      return true;
    }

    function owned(runnerId: string, record: MemberVmRecord) {
      const runner = getRunner(db, runnerId);
      if (
        !runner ||
        runner.workspaceId !== record.workspaceId ||
        runner.ownerUserId !== record.userId
      )
        throw new StepFailure("pair");
      return runner;
    }

    function renewal(record: MemberVmRecord, challenge: PairingChallenge) {
      const pairing = findRunnerPairing(db, { codeHash: workspaceTokenHash(challenge.code) });
      return (
        pairing !== null &&
        pairing.runnerId === null &&
        pairing.expiresAt > now() &&
        pairing.name === record.providerName &&
        record.requestFingerprint !== null &&
        pairing.requestFingerprint === record.requestFingerprint &&
        challenge.requestFingerprint === record.requestFingerprint
      );
    }

    async function approve(record: MemberVmRecord, challenge: PairingChallenge): Promise<boolean> {
      if (challenge.expiresAt <= now()) throw new StepFailure("pair");
      record = save({ requestFingerprint: challenge.requestFingerprint });
      const { principal } = live();
      await options.approve(principal, challenge.code, {
        requestFingerprint: challenge.requestFingerprint,
        name: record.providerName,
        authorize: () => {
          live();
        },
      });
      live();
      const approved = runnerPairingByFingerprint(db, challenge.requestFingerprint)?.runnerId;
      if (!approved) throw new StepFailure("pair");
      owned(approved, record);
      record = save({ runnerId: approved });
      return paired(record, approved);
    }

    async function paired(record: MemberVmRecord, runnerId: string): Promise<boolean> {
      const input = { runnerId, workspaceId: record.workspaceId, userId: record.userId };
      const guest = await options.bootstrap.completePairing(record.providerName);
      live();
      if (guest.phase === "paired" && guest.runnerId !== runnerId) throw new StepFailure("pair");
      if (guest.phase === "pending" && guest.challenge && renewal(record, guest.challenge)) {
        const renewed = immediate(db, () => {
          const { record: latest } = live();
          updateRunnerStatus(db, {
            runnerId,
            workspaceId: latest.workspaceId,
            userId: latest.userId,
            status: "revoked",
            now: now(),
          });
          if (!updateMemberVm(db, latest.id, latest.run, { runnerId: null }, now()))
            throw new Fenced();
          return readMemberVmById(db, latest.id)!;
        });
        return approve(renewed, guest.challenge);
      }
      if (guest.phase !== "paired" || !claimedMemberRunner(db, input)) {
        if (expired(record, pairTimeoutMs)) throw new StepFailure("pair");
        return false;
      }
      save(
        { runnerId, step: "health", state: "pending", stepStartedAt: null, runnerStarted: false },
        "health",
      );
      return true;
    }

    async function pair(record: MemberVmRecord): Promise<boolean> {
      if (record.state !== "running") record = save({ state: "running", stepStartedAt: now() });
      else if (expired(record, pairTimeoutMs)) throw new StepFailure("pair");
      const known =
        record.runnerId ??
        (record.requestFingerprint
          ? (runnerPairingByFingerprint(db, record.requestFingerprint)?.runnerId ?? null)
          : null);
      if (known) {
        const runner = owned(known, record);
        if (runner.status === "active") {
          if (record.runnerId !== known) record = save({ runnerId: known });
          return paired(record, known);
        }
        if (runner.status !== "revoked") throw new StepFailure("pair");
        record = save({ runnerId: null });
      }
      const challenge = await options.bootstrap.requestPairing(record.providerName);
      live();
      return approve(record, challenge);
    }

    async function health(record: MemberVmRecord): Promise<boolean> {
      const runnerId = record.runnerId;
      if (!runnerId) throw new StepFailure("runner");
      if (record.state !== "running")
        record = save({ state: "running", stepStartedAt: now(), runnerStarted: false });
      if (!record.runnerStarted) {
        await options.bootstrap.startRunner(record.providerName);
        live();
        record = save({ runnerStarted: true });
      }
      if (
        !memberRunnerHeartbeat(db, {
          runnerId,
          workspaceId: record.workspaceId,
          userId: record.userId,
          since: record.stepStartedAt ?? now(),
          now: now(),
        })
      ) {
        if (expired(record, healthTimeoutMs)) throw new StepFailure("runner");
        return false;
      }
      save({ step: "ready", state: "ready", failure: null, stepStartedAt: null }, "ready");
      return false;
    }

    const steps = { create, install, pair, health } as const;
    let step: string = first.step;
    try {
      for (let count = 0; count < 4; count++) {
        const { record } = live();
        if (record.step === "ready" || record.state === "failed") break;
        step = record.step;
        if (!(await steps[record.step](record))) break;
      }
    } catch (error) {
      if (error instanceof Fenced) {
        const latest = readMemberVmById(db, first.id);
        if (!latest || !authority(latest)) stop();
        return;
      }
      const code = failureCode(error, step);
      immediate(db, () => {
        const latest = readMemberVmById(db, first.id);
        if (
          !latest ||
          latest.run !== first.run ||
          latest.sessionId !== first.sessionId ||
          latest.generation !== first.generation ||
          !context.isCurrent() ||
          !authority(latest)
        )
          return;
        updateMemberVm(db, latest.id, latest.run, { state: "failed", failure: code }, now());
        progress(latest, "failed");
      });
    }
    const latest = readMemberVmById(db, first.id);
    if (!latest || latest.state === "failed") stop();
  }

  const provisioning: OnboardingVmProvisioning = {
    available: () => true,
    retry({ sessionId, generation, principal, revision, step }) {
      return immediate(db, () => {
        const scope = options.assignments.onboardingContext(sessionId, generation, principal);
        if (!scope) return "missing";
        const record = readMemberVm(db, scope.workspaceId, scope.userId);
        if (
          !record ||
          record.revision !== revision ||
          record.step !== step ||
          record.state !== "failed" ||
          PERMANENT_VM_FAILURES.has(record.failure ?? "")
        )
          return "conflict";
        updateMemberVm(
          db,
          record.id,
          record.run,
          {
            run: record.run + 1,
            state: "pending",
            failure: null,
            sessionId: scope.sessionId,
            generation: scope.generation,
            stepStartedAt: step === "create" ? now() : null,
          },
          now(),
        );
        armMemberVmJob(db, record.id, pollMs, now());
        auditWorkspaceAccess(db, {
          workspaceId: scope.workspaceId,
          userId: scope.userId,
          action: "assignment.vm_retry",
          subject: scope.sessionId,
          now: now(),
        });
        return "ok";
      });
    },
  };

  function grantAuthority(
    record: MemberVmRecord,
    sessionId: string,
    generation: number,
    repository: string,
  ) {
    const member = workspaceMember(db, record.workspaceId, record.userId);
    const runner = record.runnerId ? getRunner(db, record.runnerId) : null;
    if (
      !member?.active ||
      member.role === "observer" ||
      runner?.status !== "active" ||
      runner.workspaceId !== record.workspaceId ||
      runner.ownerUserId !== record.userId
    )
      return null;
    const scope = options.assignments.onboardingContext(sessionId, generation, {
      workspaceId: member.workspaceId,
      userId: member.userId,
      role: member.role,
      teamIds: member.teamIds,
      authenticatedAt: now(),
    });
    if (!scope) return null;
    const preparation = db
      .query<
        {
          scope: string;
          mode: string | null;
          repository_context: number;
          repository: string | null;
        },
        [string, number]
      >(
        "SELECT scope,mode,repository_context,repository FROM onboarding_preparation WHERE session_id=? AND generation=?",
      )
      .get(sessionId, generation);
    if (
      !preparation?.repository ||
      !preparation.mode ||
      (preparation.mode !== "code" && !preparation.repository_context)
    )
      return null;
    const selected = JSON.parse(preparation.repository) as { owner: string; repo: string };
    if (`${selected.owner}/${selected.repo}`.toLowerCase() !== repository.toLowerCase())
      return null;
    const installation = db
      .query<{ team_id: string }, [string]>("SELECT team_id FROM linear_session WHERE session_id=?")
      .get(sessionId);
    if (
      !installation ||
      !db
        .query(`SELECT 1 WHERE ${teamRepositoryAllowedSql("?1", "?2", "lower(?3)")}`)
        .get(record.workspaceId, installation.team_id, repository)
    )
      return null;
    const assignment = db
      .query("SELECT fingerprint FROM workspace_assignment WHERE session_id=? AND generation=?")
      .get(sessionId, generation);
    const binding = db
      .query<
        { live: number },
        [string, number]
      >(`SELECT count(*) AS live FROM onboarding_item_binding b
      JOIN work_item w ON w.id=b.item_id WHERE b.session_id=? AND b.generation=?
      AND w.state NOT IN ('cancelled','completed','merged') AND w.cancel_requested=0`)
      .get(sessionId, generation);
    const bound = db
      .query("SELECT 1 FROM onboarding_item_binding WHERE session_id=? AND generation=? LIMIT 1")
      .get(sessionId, generation);
    if (bound && !binding?.live) return null;
    const github = memberGitHubRecord(db, record.workspaceId, record.userId);
    if (
      !github?.githubId ||
      github.revoked ||
      !github.secretId ||
      (github.expiresAt !== null && github.expiresAt <= now())
    )
      return null;
    return JSON.stringify({
      scope,
      preparation,
      assignment,
      member: { role: member.role, teams: member.teamIds },
      github,
      runner: { id: runner.id, fence: runner.fence },
    });
  }

  function desiredPolicy(record: MemberVmRecord) {
    const grants = db
      .query<
        { sessionId: string; generation: number; repository: string; authority: string },
        [string]
      >(
        "SELECT session_id AS sessionId,generation,repository,authority FROM member_vm_repository_grant WHERE vm_id=?",
      )
      .all(record.id);
    const repositories: string[] = [];
    for (const grant of grants) {
      if (
        grantAuthority(record, grant.sessionId, grant.generation, grant.repository) !==
        grant.authority
      ) {
        db.run(
          "DELETE FROM member_vm_repository_grant WHERE vm_id=? AND session_id=? AND generation=?",
          [record.id, grant.sessionId, grant.generation],
        );
      } else repositories.push(grant.repository);
    }
    const desired = guestRepositoryList(repositories);
    if (JSON.stringify(desired) !== JSON.stringify(record.repositories)) {
      updateMemberVm(
        db,
        record.id,
        record.run,
        { repositories: desired, policyRevision: record.policyRevision + 1 },
        now(),
      );
    }
    return readMemberVmById(db, record.id)!;
  }

  async function reconcilePolicy(first: MemberVmRecord, context: JobContext) {
    const attempt = immediate(db, () => {
      if (!context.isCurrent()) return null;
      const latest = readMemberVmById(db, first.id);
      if (!latest || latest.run !== first.run || latest.step !== "ready") return null;
      const desired = desiredPolicy(latest);
      if (
        desired.policyAppliedRevision === desired.policyRevision &&
        desired.policyAppliedFence === desired.policyFence
      )
        return null;
      updateMemberVm(db, desired.id, desired.run, { policyFence: desired.policyFence + 1 }, now());
      return readMemberVmById(db, desired.id)!;
    });
    if (!attempt) return;
    await options.bootstrap.allowRepositories(attempt.providerName, attempt.repositories, {
      revision: attempt.policyRevision,
      fence: attempt.policyFence,
    });
    immediate(db, () => {
      const latest = readMemberVmById(db, attempt.id);
      if (!latest) return;
      const desired = desiredPolicy(latest);
      if (
        !context.isCurrent() ||
        desired.run !== attempt.run ||
        desired.policyFence !== attempt.policyFence ||
        desired.policyRevision !== attempt.policyRevision
      )
        return;
      updateMemberVm(
        db,
        desired.id,
        desired.run,
        {
          policyAppliedRevision: attempt.policyRevision,
          policyAppliedFence: attempt.policyFence,
        },
        now(),
      );
    });
  }

  return {
    provisioning,
    async allowRepository(input: MemberVmRepositoryPolicy, signal: AbortSignal): Promise<boolean> {
      signal.throwIfAborted();
      return immediate(db, () => {
        const record = readMemberVm(db, input.workspaceId, input.userId);
        if (
          !record ||
          record.step !== "ready" ||
          record.state !== "ready" ||
          record.runnerId !== input.runnerId ||
          !input.current()
        )
          return false;
        const repository = guestRepositoryList([input.repository.toLowerCase()])[0]!;
        if (input.authorized === false) {
          db.run(
            "DELETE FROM member_vm_repository_grant WHERE vm_id=? AND session_id=? AND generation=?",
            [record.id, input.sessionId, input.generation],
          );
          desiredPolicy(record);
          armMemberVmJob(db, record.id, pollMs, now());
          return false;
        }
        const granted = grantAuthority(record, input.sessionId, input.generation, repository);
        if (!granted) return false;
        db.run(
          `INSERT INTO member_vm_repository_grant(vm_id,session_id,generation,repository,authority,revision) VALUES(?,?,?,?,?,?)
          ON CONFLICT(vm_id,session_id,generation) DO UPDATE SET repository=excluded.repository,authority=excluded.authority,revision=excluded.revision`,
          [record.id, input.sessionId, input.generation, repository, granted, randomUUID()],
        );
        const desired = desiredPolicy(record);
        armMemberVmJob(db, record.id, pollMs, now());
        return (
          desired.policyAppliedRevision === desired.policyRevision &&
          desired.policyAppliedFence === desired.policyFence
        );
      });
    },
    ensure(assignment: MemberVmAssignment) {
      return immediate(db, () => {
        const scope = memberScope(assignment);
        return scope ? start(scope) : null;
      });
    },
    register(jobs: JobLoop) {
      for (const row of db
        .query<{ id: string }, []>("SELECT id FROM member_vm WHERE state!='failed'")
        .all())
        armMemberVmJob(db, row.id, pollMs, now());
      jobs.register(MEMBER_VM_QUEUE, tick);
    },
  };
}

export type MemberVmProvisioner = ReturnType<typeof createMemberVmProvisioner>;
