import type { Database } from "bun:sqlite";
import { immediate, parkLeasedJob, type Job, type JobContext, type JobLoop } from "../db";
import { isProvisioningError, type ExeDev, type ExeDevBootstrap } from "../provisioning";
import { getMemberVm, MEMBER_VM_QUEUE, type MemberRef, type MemberVm } from "./store";

export type MintEnrollment = (
  member: MemberRef,
  input: { name: string },
) => { token: string; expiresAt: number };

export type MemberVmJobOptions = {
  exeDev: ExeDev;
  bootstrap: ExeDevBootstrap;
  mintEnrollment: MintEnrollment;
  secrets?: () => readonly (string | null | undefined)[];
  now?: () => number;
  pollMs?: number;
};

export const MEMBER_VM_POLL_MS = 5_000;
export const MEMBER_VM_INSTALL_TIMEOUT_MS = 30 * 60_000;
export const MEMBER_VM_HEALTH_TIMEOUT_MS = 10 * 60_000;
const TOKEN_MARGIN_MS = 60_000;
const MAX_FAILURE = 500;

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
    if (row === null || row.failure !== null || row.step === "ready") return;
    const minted: string[] = [];
    let outcome: Outcome;
    try {
      outcome = await runStep(db, row, options, now, (token) => minted.push(token));
    } catch (error) {
      if (error instanceof StepMoved || !context.isCurrent()) return;
      const text = redact(errorText(error), [...minted, ...(options.secrets?.() ?? [])]);
      const at = now();
      db.run("UPDATE member_vm SET failure=?,updated_at=? WHERE id=? AND step=?", [
        text,
        at,
        row.id,
        row.step,
      ]);
      return;
    }
    if (outcome.next === "done" || !context.isCurrent()) return;
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
  options: MemberVmJobOptions,
  now: () => number,
  minted: (token: string) => void,
): Promise<Outcome> {
  const { exeDev, bootstrap } = options;
  const vm = row.vmName;
  const member = { workspaceId: row.workspaceId, userId: row.userId };
  const mint = () => {
    const enrollment = options.mintEnrollment(member, { name: vm });
    minted(enrollment.token);
    return enrollment;
  };

  switch (row.step) {
    case "create": {
      const asked = row.createRequestedAt;
      update(db, row, { create_requested_at: asked ?? now() }, now());
      try {
        await exeDev.createVm(vm);
      } catch (error) {
        if (!(isProvisioningError(error) && error.code === "conflict")) throw error;
        if (asked === null)
          throw new Error(
            `exe.dev already has a VM named ${vm} that Paws did not create (conflict).`,
            {
              cause: error,
            },
          );
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
            install_started_at: now(),
            ...(started === "started" ? { token_expires_at: enrollment.expiresAt } : {}),
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
      if (row.tokenExpiresAt === null || row.tokenExpiresAt - TOKEN_MARGIN_MS <= now()) {
        const enrollment = mint();
        await bootstrap.stageToken(vm, enrollment.token);
        update(db, row, { token_expires_at: enrollment.expiresAt }, now());
      }
      update(db, row, { token_expires_at: null }, now());
      const enrolled = await bootstrap.enroll(vm);
      const runner = db
        .query<{ workspaceId: string; ownerUserId: string; status: string }, [string]>(
          "SELECT workspace_id AS workspaceId,owner_user_id AS ownerUserId,status FROM runner WHERE id=?",
        )
        .get(enrolled.runnerId);
      if (
        runner === null ||
        enrolled.workspaceId !== row.workspaceId ||
        runner.workspaceId !== row.workspaceId ||
        runner.ownerUserId !== row.userId
      )
        throw new Error(`${vm}: enrollment returned a runner this member does not own.`);
      if (runner.status === "revoked")
        throw new Error(
          `${vm}: the VM still holds the identity of a removed runner and did not enroll again.`,
        );
      update(db, row, { runner_id: enrolled.runnerId }, now());
      await bootstrap.startRunner(vm);
      advance(db, row, "health", now());
      return { next: "advance" };
    }

    case "health": {
      const runner =
        row.runnerId === null
          ? null
          : db
              .query<{ lastSeenAt: number | null; status: string }, [string]>(
                "SELECT last_seen_at AS lastSeenAt,status FROM runner WHERE id=?",
              )
              .get(row.runnerId);
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

type Columns = {
  create_requested_at?: number;
  install_started_at?: number;
  token_expires_at?: number | null;
  runner_id?: string;
};

function update(db: Database, row: MemberVm, columns: Columns, at: number): void {
  const entries = Object.entries(columns);
  if (entries.length === 0) return;
  const changed = db.run(
    `UPDATE member_vm SET ${entries.map(([name]) => `${name}=?`).join(",")},updated_at=?
    WHERE id=? AND step=? AND failure IS NULL`,
    [...entries.map(([, value]) => value ?? null), at, row.id, row.step],
  ).changes;
  if (changed !== 1) throw new StepMoved();
}

function advance(db: Database, row: MemberVm, step: MemberVm["step"], at: number): void {
  immediate(db, () => {
    const changed = db.run(
      `UPDATE member_vm SET step=?,step_started_at=?,updated_at=? WHERE id=? AND step=? AND failure IS NULL`,
      [step, at, at, row.id, row.step],
    ).changes;
    if (changed !== 1) throw new StepMoved();
  });
}

class StepMoved extends Error {
  constructor() {
    super("The member VM moved on while this step ran.");
  }
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
