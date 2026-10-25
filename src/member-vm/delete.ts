import type { Database } from "bun:sqlite";
import { TERMINAL_WORK_ITEM_STATES } from "../core";
import {
  auditWorkspaceAccess,
  immediate,
  parkLeasedJob,
  updateRunnerStatus,
  type Job,
  type JobContext,
  type JobLoop,
} from "../db";
import type { ExeDev } from "../provisioning";
import { redact } from "./job";
import {
  getMemberVm,
  MEMBER_VM_DELETE_QUEUE,
  MEMBER_VM_QUEUE,
  type MemberVm,
  type MemberVmBlockingTask,
  type MemberVmDeleteStep,
} from "./store";

type Secrets = readonly (string | null | undefined | Promise<string | null>)[];

export type MemberVmDeleteJobOptions = {
  exeDev: ExeDev | (() => ExeDev | Promise<ExeDev>);
  /** Stops a task the way Stop on the run page does. Called only for a forced delete. */
  stopTask: (itemId: string) => Promise<void>;
  /** Drops the live connection of a revoked runner certificate, as removing a runner does. */
  disconnect?: (fingerprint: string) => void;
  secrets?: () => Secrets | Promise<Secrets>;
  now?: () => number;
};

/**
 * Leaves the tailnet when the VM joined it (PAS-656 installs `/usr/bin/tailscale` only to join),
 * so the node does not linger in the admin console. A VM that never joined does nothing.
 */
export const MEMBER_VM_TAILNET_LOGOUT =
  "if [ -x /usr/bin/tailscale ]; then sudo tailscale logout; fi";
const TAILNET_LOGOUT_TIMEOUT_MS = 60_000;

type Outcome = "advance" | "done";

export function registerMemberVmDeleteJob(jobs: JobLoop, options: MemberVmDeleteJobOptions): void {
  jobs.register(MEMBER_VM_DELETE_QUEUE, createMemberVmDeleteHandler(jobs.db, options));
}

/**
 * Runs one delete step per lease and parks the job for the next. Every step checks what is
 * already done first, so a re-run after a restart, a retry or a duplicate job is a no-op.
 */
export function createMemberVmDeleteHandler(db: Database, options: MemberVmDeleteJobOptions) {
  const now = options.now ?? Date.now;
  return async (job: Job, context: JobContext): Promise<void> => {
    const id = memberVmId(job.payload);
    const row = id === null ? null : getMemberVm(db, id);
    if (row === null || row.deleteStep === null || row.deleteFailure !== null) return;
    let outcome: Outcome;
    try {
      outcome = await runDeleteStep(db, row, options, now);
    } catch (error) {
      if (error instanceof StepMoved || !context.isCurrent()) return;
      const secrets = await Promise.resolve()
        .then(() => options.secrets?.())
        .then((list) => Promise.all(list ?? []))
        .catch(() => []);
      const text = redact(error instanceof Error ? error.message : String(error), secrets);
      const at = now();
      db.run(
        `UPDATE member_vm SET delete_failure=?,updated_at=?
        WHERE id=? AND delete_step=? AND delete_failure IS NULL`,
        [text, at, row.id, row.deleteStep],
      );
      return;
    }
    if (outcome === "done" || !context.isCurrent()) return;
    const at = now();
    parkLeasedJob(db, job, { runAt: at, payload: job.payload, attempts: job.attempts - 1, now: at });
  };
}

async function runDeleteStep(
  db: Database,
  row: MemberVm,
  options: MemberVmDeleteJobOptions,
  now: () => number,
): Promise<Outcome> {
  const vm = row.vmName;
  // Before exe.dev was asked to create it, a VM by this name is not Paws's to touch: it may be
  // the one a create refused with `conflict`.
  const ours = !(row.step === "create" && row.createRequestedAt === null);
  const actor = row.deleteRequestedBy ?? row.userId;
  switch (row.deleteStep) {
    case "drain": {
      const runner = row.deleteRunnerId === null ? null : liveRunner(db, row.deleteRunnerId);
      if (runner !== null && runner.status !== "draining")
        updateRunnerStatus(db, {
          runnerId: runner.id,
          workspaceId: runner.workspaceId,
          userId: actor,
          status: "draining",
          now: now(),
        });
      const tasks = row.deleteRunnerId === null ? [] : blockingTasks(db, row.deleteRunnerId, now());
      if (tasks.length > 0 && row.deleteForce !== 1) {
        const names = tasks.map((task) => task.identifier).join(", ");
        const changed = db.run(
          `UPDATE member_vm SET delete_failure=?,delete_blocked=?,updated_at=?
          WHERE id=? AND delete_step='drain' AND delete_failure IS NULL`,
          [
            `${names} ${tasks.length === 1 ? "is" : "are"} running on ${vm}. Wait for ${tasks.length === 1 ? "it" : "them"} to finish and retry, or force the delete to stop ${tasks.length === 1 ? "it" : "them"}.`,
            JSON.stringify(tasks),
            now(),
            row.id,
          ],
        ).changes;
        if (changed !== 1) throw new StepMoved();
        return "done";
      }
      for (const task of tasks) {
        await options.stopTask(task.itemId);
        auditWorkspaceAccess(db, {
          workspaceId: row.workspaceId,
          userId: actor,
          action: "member_vm.delete.stop_task",
          subject: task.itemId,
          now: now(),
        });
      }
      advance(db, row, "tailnet", now());
      return "advance";
    }

    case "tailnet": {
      if (ours) {
        try {
          const exeDev = await resolve(options.exeDev);
          await exeDev.execVm(vm, MEMBER_VM_TAILNET_LOGOUT, {
            timeoutMs: TAILNET_LOGOUT_TIMEOUT_MS,
          });
        } catch {
          // Leaving the tailnet is best effort: a VM that is gone or unreachable still gets deleted.
        }
      }
      advance(db, row, "revoke", now());
      return "advance";
    }

    case "revoke": {
      // The same path as removing a paired runner: revoke the runner and its certificates, then
      // drop their connections. An in-flight enrollment may have set runner_id after the start.
      const ids = new Set([row.deleteRunnerId, row.runnerId].filter((value) => value !== null));
      for (const runnerId of ids) {
        const runner = liveRunner(db, runnerId);
        if (runner === null) continue;
        const fingerprints = updateRunnerStatus(db, {
          runnerId,
          workspaceId: runner.workspaceId,
          userId: actor,
          status: "revoked",
          now: now(),
        });
        for (const fingerprint of fingerprints) options.disconnect?.(fingerprint);
      }
      advance(db, row, "destroy", now());
      return "advance";
    }

    case "destroy": {
      if (ours) await (await resolve(options.exeDev)).deleteVm(vm);
      advance(db, row, "clear", now());
      return "advance";
    }

    case "clear": {
      immediate(db, () => {
        const at = now();
        db.run(
          `UPDATE job SET status='cancelled',finished_at=?,locked_by=NULL,locked_until=NULL,
          last_error='member VM deleted' WHERE queue=? AND status IN ('pending','running')
          AND json_extract(payload,'$.memberVmId')=?`,
          [at, MEMBER_VM_QUEUE, row.id],
        );
        const removed = db.run(
          "DELETE FROM member_vm WHERE id=? AND delete_step='clear' AND delete_failure IS NULL",
          [row.id],
        ).changes;
        if (removed !== 1) throw new StepMoved();
        auditWorkspaceAccess(db, {
          workspaceId: row.workspaceId,
          userId: actor,
          action: "member_vm.deleted",
          subject: vm,
          now: at,
        });
      });
      return "done";
    }
  }
  return "done";
}

/** The tasks holding work on the runner that have not been stopped, oldest first. */
export function blockingTasks(db: Database, runnerId: string, now: number): MemberVmBlockingTask[] {
  const terminal = TERMINAL_WORK_ITEM_STATES as readonly string[];
  return db
    .query<MemberVmBlockingTask, [string, number, ...string[]]>(
      `SELECT DISTINCT i.id AS itemId,i.linear_identifier AS identifier,i.title
      FROM runner_work w JOIN run r ON r.id=w.run_id JOIN work_item i ON i.id=r.item_id
      WHERE w.runner_id=? AND ((w.ended_at IS NULL AND w.lease_until>?) OR r.status IN ('active','provisioning'))
      AND i.cancel_requested=0 AND i.state NOT IN (${terminal.map(() => "?").join(",")})
      ORDER BY r.created_at,i.id`,
    )
    .all(runnerId, now, ...terminal);
}

function liveRunner(
  db: Database,
  id: string,
): { id: string; workspaceId: string; status: string } | null {
  return db
    .query<{ id: string; workspaceId: string; status: string }, [string]>(
      `SELECT id,workspace_id AS workspaceId,status FROM runner
      WHERE id=? AND status<>'revoked' AND revoked_at IS NULL`,
    )
    .get(id);
}

function advance(db: Database, row: MemberVm, step: MemberVmDeleteStep, at: number): void {
  const changed = db.run(
    `UPDATE member_vm SET delete_step=?,delete_step_started_at=?,
    delete_at=json_set(COALESCE(delete_at,'{}'),'$.' || ?,?),updated_at=?
    WHERE id=? AND delete_step=? AND delete_failure IS NULL`,
    [step, at, step, at, at, row.id, row.deleteStep],
  ).changes;
  if (changed !== 1) throw new StepMoved();
}

class StepMoved extends Error {
  constructor() {
    super("The member VM delete moved on while this step ran.");
  }
}

async function resolve(exeDev: MemberVmDeleteJobOptions["exeDev"]): Promise<ExeDev> {
  return typeof exeDev === "function" ? await exeDev() : exeDev;
}

function memberVmId(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const value = (payload as { memberVmId?: unknown }).memberVmId;
  return typeof value === "string" ? value : null;
}
