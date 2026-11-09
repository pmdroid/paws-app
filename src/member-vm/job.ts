import { journalCaught } from "../journal";
import type { Database } from "bun:sqlite";
import {
  advanceMemberVmStep,
  failMemberVmStep,
  immediate,
  parkLeasedJob,
  recordMemberVmEnrollment,
  restoreMemberVmCreateRequest,
  runnerIdentity,
  updateMemberVmStep,
  type Job,
  type JobContext,
  type JobLoop,
  type MemberVmStepFields,
} from "../db";
import {
  isProvisioningError,
  type ExeDev,
  type ExeDevBootstrap,
  type ExeDevVmSize,
  type ProvisioningErrorCode,
} from "../provisioning";
import { workspaceTokenHash } from "../workspace";
import { freeVmName, getMemberVm, MEMBER_VM_QUEUE, type MemberRef, type MemberVm } from "./store";

export type MintEnrollment = (
  member: MemberRef,
  input: { name: string },
) => { token: string; expiresAt: number };

type Secrets = readonly (string | null | undefined | Promise<string | null>)[];

export type MemberVmProvisioning = {
  exeDev: ExeDev;
  bootstrap: ExeDevBootstrap;
  mintEnrollment: MintEnrollment;
  /** `[member_vm]` in config.toml. Missing: a bare `new`, exe.dev's default size. */
  size?: ExeDevVmSize;
};

export type MemberVmJobOptions = (
  | MemberVmProvisioning
  | { provision: () => MemberVmProvisioning | Promise<MemberVmProvisioning> }
) & {
  secrets?: () => Secrets | Promise<Secrets>;
  now?: () => number;
  pollMs?: number;
};

export const MEMBER_VM_POLL_MS = 5_000;
export const MEMBER_VM_INSTALL_TIMEOUT_MS = 30 * 60_000;
export const MEMBER_VM_HEALTH_TIMEOUT_MS = 10 * 60_000;
const TOKEN_MARGIN_MS = 60_000;
const MAX_FAILURE = 500;
const REJECTED: ReadonlySet<ProvisioningErrorCode> = new Set([
  "invalid_name",
  "invalid_command",
  "no_token",
  "unauthorized",
  "conflict",
  "name_unavailable",
  "missing",
  "rate_limited",
]);

type Outcome = { next: "advance" | "poll" | "done" };

export function registerMemberVmJob(jobs: JobLoop, options: MemberVmJobOptions): void {
  const handler = createMemberVmHandler(jobs.db, options);
  jobs.register(MEMBER_VM_QUEUE, handler);
}

export function createMemberVmHandler(db: Database, options: MemberVmJobOptions) {
  const now = options.now ?? Date.now;
  const pollMs = options.pollMs ?? MEMBER_VM_POLL_MS;

  return async (job: Job, context: JobContext): Promise<void> => {
    const id = memberVmId(job.payload);
    const row = id === null ? null : getMemberVm(db, id);
    if (row === null || row.failure !== null || row.step === "ready" || row.deleteStep !== null)
      return;
    const minted: string[] = [];
    let outcome: Outcome;
    try {
      const provisioning = "provision" in options ? await options.provision() : options;
      outcome = await runStep(db, row, provisioning, now, (token) => minted.push(token));
    } catch (error) {
      if (error instanceof StepMoved || !context.isCurrent()) return;
      const secrets = await Promise.resolve()
        .then(() => options.secrets?.())
        .then((list) => Promise.all(list ?? []))
        .catch((caughtError1) => {
          journalCaught(caughtError1, "job.createMemberVmHandler.then", null);
          return [];
        });
      const text = redact(errorText(error), [...minted, ...secrets]);
      journalCaught(text, "member-vm.provision");
      const at = now();
      failMemberVmStep(db, { id: row.id, step: row.step, failure: text, now: at });
      return;
    }
    if (outcome.next === "done" || !context.isCurrent()) return;
    if (getMemberVm(db, row.id)?.deleteStep != null) return;
    const at = now();
    parkLeasedJob(db, job, {
      runAt: outcome.next === "advance" ? at : at + pollMs,
      payload: job.payload,
      attempts: job.attempts - 1,
      now: at,
    });
  };
}

async function runStep(
  db: Database,
  row: MemberVm,
  options: MemberVmProvisioning,
  now: () => number,
  minted: (token: string) => void,
): Promise<Outcome> {
  const { exeDev, bootstrap } = options;
  const vm = row.vmName;
  const member = { workspaceId: row.workspaceId, userId: row.userId };
  const mint = () => {
    const enrollment = options.mintEnrollment(member, { name: vm });
    minted(enrollment.token);
    recordMemberVmEnrollment(db, {
      tokenHash: workspaceTokenHash(enrollment.token),
      memberVmId: row.id,
      now: now(),
    });
    return enrollment;
  };

  switch (row.step) {
    case "create": {
      const asked = row.createRequestedAt;
      update(db, row, { createRequestedAt: asked ?? now() }, now());
      try {
        await exeDev.createVm(
          vm,
          row.pool === null ? options.size : { ...options.size, pool: row.pool },
        );
      } catch (error) {
        const ours = isProvisioningError(error) && error.code === "conflict" && asked !== null;
        if (ours) journalCaught(error, "member-vm.createVm", null, "resuming our create request");
        // exe.dev names are global, so another account may hold this one. Nothing was created
        // under it for us, so the row takes the next name and asks again.
        if (asked === null && isProvisioningError(error) && error.code === "name_unavailable") {
          journalCaught(error, "member-vm.createVm", null, "trying the next VM name");
          update(db, row, { vmName: freeVmName(db, member, vm), createRequestedAt: null }, now());
          return { next: "advance" };
        }
        if (!ours) {
          if (rejected(error)) restoreMemberVmCreateRequest(db, row.id, asked);
          if (isProvisioningError(error) && error.code === "conflict")
            throw new Error(
              `exe.dev already has a VM named ${vm} that Paws did not create (conflict).`,
              { cause: error },
            );
          throw error;
        }
      }
      advance(db, row, "install", now());
      return { next: "advance" };
    }

    case "install": {
      if (row.installStartedAt === null) {
        const enrollment = mint();
        const started = await bootstrap.startInstall(vm, enrollment.token);
        update(
          db,
          row,
          {
            installStartedAt: now(),
            ...(started === "started" ? { tokenExpiresAt: enrollment.expiresAt } : {}),
          },
          now(),
        );
        if (started === "succeeded") {
          advance(db, row, "enroll", now());
          return { next: "advance" };
        }
        return { next: "poll" };
      }
      const status = await bootstrap.installStatus(vm);
      if (status === "succeeded") {
        advance(db, row, "enroll", now());
        return { next: "advance" };
      }
      if (status === "failed") throw new Error(`${vm}: the runner install failed.`);
      if (now() - row.stepStartedAt >= MEMBER_VM_INSTALL_TIMEOUT_MS)
        throw new Error(`${vm}: the runner install did not finish within 30 minutes.`);
      return { next: "poll" };
    }

    case "enroll": {
      // The runner enrolls with this Paws, so a Paws reachable only on Tailscale needs the VM on
      // its tailnet first. Without an auth key this is a no-op; on a joined VM only a reach check.
      await bootstrap.joinTailnet(vm);
      let tokenExpiresAt = row.tokenExpiresAt;
      for (let attempt = 0; ; attempt++) {
        if (tokenExpiresAt === null || tokenExpiresAt - TOKEN_MARGIN_MS <= now()) {
          const enrollment = mint();
          await bootstrap.stageToken(vm, enrollment.token);
          update(db, row, { tokenExpiresAt: enrollment.expiresAt }, now());
        }
        update(db, row, { tokenExpiresAt: null }, now());
        tokenExpiresAt = null;
        const enrolled = await bootstrap.enroll(vm);
        const runner = runnerIdentity(db, enrolled.runnerId);
        if (
          runner === null ||
          enrolled.workspaceId !== row.workspaceId ||
          runner.workspaceId !== row.workspaceId ||
          runner.ownerId !== row.userId
        )
          throw new Error(`${vm}: enrollment returned a runner this member does not own.`);
        if (runner.status === "revoked" || runner.revokedAt !== null) {
          if (attempt > 0)
            throw new Error(`${vm}: the VM kept the identity of a removed runner after a reset.`);
          await bootstrap.resetIdentity(vm);
          continue;
        }
        update(db, row, { runnerId: enrolled.runnerId }, now());
        await bootstrap.startRunner(vm);
        advance(db, row, "health", now());
        return { next: "advance" };
      }
    }

    case "health": {
      const runner = row.runnerId === null ? null : runnerIdentity(db, row.runnerId);
      if (runner === null || runner.status === "revoked")
        throw new Error(`${vm}: the runner was removed before its first heartbeat.`);
      if (runner.lastSeenAt !== null) {
        advance(db, row, "ready", now());
        return { next: "done" };
      }
      if (now() - row.stepStartedAt >= MEMBER_VM_HEALTH_TIMEOUT_MS)
        throw new Error(`${vm}: the runner sent no heartbeat within ten minutes.`);
      return { next: "poll" };
    }

    case "ready":
      return { next: "done" };
  }
}

function update(db: Database, row: MemberVm, fields: MemberVmStepFields, at: number): void {
  if (Object.keys(fields).length === 0) return;
  if (updateMemberVmStep(db, { id: row.id, step: row.step, fields, now: at }) !== 1)
    throw new StepMoved();
}

function advance(
  db: Database,
  row: MemberVm,
  step: Exclude<MemberVm["step"], "create">,
  at: number,
): void {
  immediate(db, () => {
    if (advanceMemberVmStep(db, { id: row.id, from: row.step, to: step, now: at }) !== 1)
      throw new StepMoved();
  });
}

class StepMoved extends Error {
  constructor() {
    super("The member VM moved on while this step ran.");
  }
}

function rejected(error: unknown): boolean {
  if (!isProvisioningError(error)) return false;
  if (REJECTED.has(error.code)) return true;
  return error.status !== null && error.status >= 400 && error.status < 500;
}

function memberVmId(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const value = (payload as { memberVmId?: unknown }).memberVmId;
  return typeof value === "string" ? value : null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function redact(text: string, secrets: readonly (string | null | undefined)[]): string {
  let value = text;
  for (const secret of secrets)
    if (secret && secret.length >= 8) value = value.replaceAll(secret, "[redacted]");
  value = value.replace(/[A-Za-z0-9_-]{32,}/g, (run) => (/[A-Z_]/.test(run) ? "[redacted]" : run));
  return value.length > MAX_FAILURE ? `${value.slice(0, MAX_FAILURE - 1)}…` : value;
}
