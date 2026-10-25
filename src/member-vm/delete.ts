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
import { isProvisioningError, type ExeDev } from "../provisioning";
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
  stopTask: (itemId: string) => Promise<void>;
  disconnect?: (fingerprint: string) => void;
  secrets?: () => Secrets | Promise<Secrets>;
  now?: () => number;
  pollMs?: number;
};

export const MEMBER_VM_DELETE_POLL_MS = 2_000;

export const MEMBER_VM_TAILNET_LOGOUT =
  "if [ -x /usr/bin/tailscale ]; then sudo tailscale logout; fi";
const TAILNET_LOGOUT_TIMEOUT_MS = 60_000;

type Outcome = "advance" | "wait" | "done";

export function registerMemberVmDeleteJob(jobs: JobLoop, options: MemberVmDeleteJobOptions): void {
  jobs.register(MEMBER_VM_DELETE_QUEUE, createMemberVmDeleteHandler(jobs.db, options));
}

export function createMemberVmDeleteHandler(db: Database, options: MemberVmDeleteJobOptions) {
  const now = options.now ?? Date.now;
  const pollMs = options.pollMs ?? MEMBER_VM_DELETE_POLL_MS;
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
    parkLeasedJob(db, job, {
      runAt: outcome === "wait" ? at + pollMs : at,
      payload: job.payload,
      attempts: job.attempts - 1,
      now: at,
    });
  };
}

async function runDeleteStep(
  db: Database,
  row: MemberVm,
  options: MemberVmDeleteJobOptions,
  now: () => number,
): Promise<Outcome> {
  const vm = row.vmName;
  const created = row.step !== "create";
  const actor = row.deleteRequestedBy ?? row.userId;
  switch (row.deleteStep) {
    case "drain": {
      if (provisioningInFlight(db, row.id, now())) return "wait";
      revokeUnusedEnrollments(db, row);
      const runnerId = row.deleteRunnerId ?? row.runnerId;
      if (row.deleteRunnerId === null && runnerId !== null)
        db.run("UPDATE member_vm SET delete_runner_id=? WHERE id=? AND delete_step='drain'", [
          runnerId,
          row.id,
        ]);
      const runners = vmRunners(db, row);
      for (const runner of runners)
        if (runner.status !== "draining")
          updateRunnerStatus(db, {
            runnerId: runner.id,
            workspaceId: runner.workspaceId,
            userId: actor,
            status: "draining",
            now: now(),
          });
      const seen = new Set<string>();
      const tasks = runners
        .flatMap((runner) => blockingTasks(db, runner.id, now()))
        .filter((task) => !seen.has(task.itemId) && seen.add(task.itemId));
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
      if (created) {
        try {
          const exeDev = await resolve(options.exeDev);
          await exeDev.execVm(vm, MEMBER_VM_TAILNET_LOGOUT, {
            timeoutMs: TAILNET_LOGOUT_TIMEOUT_MS,
          });
        } catch {}
      }
      advance(db, row, "revoke", now());
      return "advance";
    }

    case "revoke": {
      revokeUnusedEnrollments(db, row);
      for (const runner of vmRunners(db, row)) {
        const fingerprints = updateRunnerStatus(db, {
          runnerId: runner.id,
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
      const exeDev = await resolve(options.exeDev);
      if (created) await exeDev.deleteVm(vm);
      else if (row.createRequestedAt !== null) {
        const exists = await exeDev.getVm(vm).then(
          () => true,
          (error: unknown) => {
            if (isProvisioningError(error) && error.code === "missing") return false;
            throw error;
          },
        );
        if (exists)
          throw new Error(
            `exe.dev has a VM named ${vm}, but its create was interrupted before exe.dev answered, so Paws cannot tell whether it made it. Paws left it in place. If it is yours, remove it on exe.dev, then Retry.`,
          );
      }
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
        db.run("DELETE FROM member_vm_enrollment WHERE member_vm_id=?", [row.id]);
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

function provisioningInFlight(db: Database, id: string, now: number): boolean {
  return (
    db
      .query<{ one: number }, [string, number, string]>(
        `SELECT 1 AS one FROM job WHERE queue=? AND status='running' AND locked_until>?
        AND json_extract(payload,'$.memberVmId')=? LIMIT 1`,
      )
      .get(MEMBER_VM_QUEUE, now, id) !== null
  );
}

function revokeUnusedEnrollments(db: Database, row: MemberVm): void {
  db.run(
    `DELETE FROM runner_enrollment WHERE used_at IS NULL AND token_hash IN
    (SELECT token_hash FROM member_vm_enrollment WHERE member_vm_id=?)`,
    [row.id],
  );
}

function vmRunners(
  db: Database,
  row: MemberVm,
): { id: string; workspaceId: string; status: string }[] {
  const enrolled = db
    .query<{ runnerId: string }, [string]>(
      `SELECT e.runner_id AS runnerId FROM member_vm_enrollment m
      JOIN runner_enrollment e ON e.token_hash=m.token_hash
      WHERE m.member_vm_id=? AND e.runner_id IS NOT NULL`,
    )
    .all(row.id)
    .map((entry) => entry.runnerId);
  const ids = new Set(
    [row.deleteRunnerId, row.runnerId, ...enrolled].filter((value) => value !== null),
  );
  return [...ids]
    .map((id) => liveRunner(db, id))
    .filter(
      (runner): runner is NonNullable<typeof runner> =>
        runner !== null && runner.workspaceId === row.workspaceId,
    );
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
