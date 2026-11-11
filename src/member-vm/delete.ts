import { journalCaught } from "../journal";
import {
  advanceMemberVmDeleteSteps,
  auditWorkspaceAccessSteps,
  blockMemberVmDeleteSteps,
  clearDeletedMemberVmSteps,
  failMemberVmDeleteSteps,
  itemStopRequestedSteps,
  liveRunnerSteps,
  memberVmByIdSteps,
  memberVmEnrolledRunnerIdsSteps,
  memberVmJobRunningSteps,
  nameEnrolledRunnersSteps,
  parkLeasedJobSteps,
  pendingNameEnrollmentSteps,
  revokeUnusedMemberVmEnrollmentsSteps,
  runnerBlockingTasksSteps,
  setMemberVmDeleteRunnerSteps,
  updateRunnerStatus,
  type Db,
  type Job,
  type JobContext,
  type JobLoop,
  type MemberVmRunner,
  runnerLeaseCutoff,
} from "../db";
import { isProvisioningError, type ExeDev } from "../provisioning";
import { redact } from "./job";
import {
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
  jobs.register(MEMBER_VM_DELETE_QUEUE, createMemberVmDeleteHandler(jobs.store, options));
}

export function createMemberVmDeleteHandler(store: Db, options: MemberVmDeleteJobOptions) {
  const now = options.now ?? Date.now;
  const pollMs = options.pollMs ?? MEMBER_VM_DELETE_POLL_MS;
  return async (job: Job, context: JobContext): Promise<void> => {
    const id = memberVmId(job.payload);
    const row = id === null ? null : await store.run((q) => memberVmByIdSteps(q, id));
    if (row === null || row.deleteStep === null || row.deleteFailure !== null) return;
    let outcome: Outcome;
    try {
      outcome = await runDeleteStep(store, row, options, now);
    } catch (error) {
      if (error instanceof StepMoved || !(await context.isCurrent())) return;
      const secrets = await Promise.resolve()
        .then(() => options.secrets?.())
        .then((list) => Promise.all(list ?? []))
        .catch((caughtError1) => {
          journalCaught(caughtError1, "delete.createMemberVmDeleteHandler.then", null);
          return [];
        });
      const text = redact(error instanceof Error ? error.message : String(error), secrets);
      journalCaught(text, "member-vm.delete");
      const step = row.deleteStep;
      await store.run((q) => failMemberVmDeleteSteps(q, row.id, step, text, now()));
      return;
    }
    if (outcome === "done" || !(await context.isCurrent())) return;
    const at = now();
    await store.run((q) =>
      parkLeasedJobSteps(q, job, {
        runAt: outcome === "wait" ? at + pollMs : at,
        payload: job.payload,
        attempts: job.attempts - 1,
        now: at,
      }),
    );
  };
}

async function runDeleteStep(
  store: Db,
  row: MemberVm,
  options: MemberVmDeleteJobOptions,
  now: () => number,
): Promise<Outcome> {
  const vm = row.vmName;
  const created = row.step !== "create";
  const actor = row.deleteRequestedBy ?? row.userId;
  switch (row.deleteStep) {
    case "drain": {
      if (await store.run((q) => memberVmJobRunningSteps(q, MEMBER_VM_QUEUE, row.id, now())))
        return "wait";
      await store.run((q) => revokeUnusedMemberVmEnrollmentsSteps(q, row.id));
      const runnerId = row.deleteRunnerId ?? row.runnerId;
      if (row.deleteRunnerId === null && runnerId !== null)
        await store.run((q) => setMemberVmDeleteRunnerSteps(q, row.id, runnerId));
      const runners = await vmRunners(store, row);
      for (const runner of runners)
        if (runner.status !== "draining")
          await updateRunnerStatus(store, {
            runnerId: runner.id,
            workspaceId: runner.workspaceId,
            userId: actor,
            status: "draining",
            now: now(),
          });
      if (row.enrollmentsTracked !== 1) await untrackedEnrollments(store, row, runners, now());
      const seen = new Set<string>();
      const tasks: MemberVmBlockingTask[] = [];
      for (const runner of runners)
        for (const task of await blockingTasks(store, runner.id, now()))
          if (!seen.has(task.itemId) && seen.add(task.itemId)) tasks.push(task);
      if (tasks.length > 0 && row.deleteForce !== 1) {
        const names = tasks.map((task) => task.identifier).join(", ");
        const failure = `${names} ${tasks.length === 1 ? "is" : "are"} running on ${vm}. Wait for ${tasks.length === 1 ? "it" : "them"} to finish and retry, or force the delete to stop ${tasks.length === 1 ? "it" : "them"}.`;
        const at = now();
        if (!(await store.run((q) => blockMemberVmDeleteSteps(q, row.id, failure, tasks, at))))
          throw new StepMoved();
        return "done";
      }
      for (const task of tasks) {
        if (await store.run((q) => itemStopRequestedSteps(q, task.itemId))) continue;
        await options.stopTask(task.itemId);
        await store.run((q) =>
          auditWorkspaceAccessSteps(q, {
            workspaceId: row.workspaceId,
            userId: actor,
            action: "member_vm.delete.stop_task",
            subject: task.itemId,
            now: now(),
          }),
        );
      }
      await advance(store, row, "tailnet", now());
      return "advance";
    }

    case "tailnet": {
      if (created) {
        try {
          const exeDev = await resolve(options.exeDev);
          await exeDev.execVm(vm, MEMBER_VM_TAILNET_LOGOUT, {
            timeoutMs: TAILNET_LOGOUT_TIMEOUT_MS,
          });
        } catch (caughtError2) {
          journalCaught(caughtError2, "delete.runDeleteStep.resolve", null);
        }
      }
      await advance(store, row, "revoke", now());
      return "advance";
    }

    case "revoke": {
      await store.run((q) => revokeUnusedMemberVmEnrollmentsSteps(q, row.id));
      for (const runner of await vmRunners(store, row)) {
        const fingerprints = await updateRunnerStatus(store, {
          runnerId: runner.id,
          workspaceId: runner.workspaceId,
          userId: actor,
          status: "revoked",
          now: now(),
        });
        for (const fingerprint of fingerprints) options.disconnect?.(fingerprint);
      }
      await advance(store, row, "destroy", now());
      return "advance";
    }

    case "destroy": {
      const exeDev = await resolve(options.exeDev);
      if (created) await exeDev.deleteVm(vm);
      else if (row.createRequestedAt !== null) {
        const exists = await exeDev.getVm(vm).then(
          () => true,
          (error: unknown) => {
            journalCaught(error, "delete.runDeleteStep.getVm", null);
            if (isProvisioningError(error) && error.code === "missing") return false;
            throw error;
          },
        );
        if (exists)
          throw new Error(
            `exe.dev has a VM named ${vm}, but its create was interrupted before exe.dev answered, so Paws cannot tell whether it made it. Paws left it in place. If it is yours, remove it on exe.dev, then Retry.`,
          );
      }
      await advance(store, row, "clear", now());
      return "advance";
    }

    case "clear": {
      await store.transaction(function* (q) {
        const at = now();
        if (!(yield* clearDeletedMemberVmSteps(q, row.id, MEMBER_VM_QUEUE, at)))
          throw new StepMoved();
        yield* auditWorkspaceAccessSteps(q, {
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

export function blockingTasks(
  store: Db,
  runnerId: string,
  now: number,
): Promise<MemberVmBlockingTask[]> {
  return store.run((q) => runnerBlockingTasksSteps(q, runnerId, runnerLeaseCutoff(now)));
}

async function untrackedEnrollments(
  store: Db,
  row: MemberVm,
  known: readonly { id: string }[],
  now: number,
): Promise<void> {
  const ids = new Set(known.map((runner) => runner.id));
  const runners = (
    await store.run((q) =>
      nameEnrolledRunnersSteps(q, row.workspaceId, row.userId, row.vmName, row.createdAt),
    )
  ).filter((runner) => !ids.has(runner.id));
  if (runners.length > 0)
    throw new Error(
      `${row.vmName} was created before Paws recorded which runners a VM enrolls, so Paws cannot tell whether ${runners.map((runner) => `runner ${runner.name} (${runner.id})`).join(", ")} belongs to it or was paired by hand. Ask a workspace admin to revoke it on its runner page, then Retry. A host paired by hand under this name has to be revoked and paired again.`,
    );
  const pending = await store.run((q) =>
    pendingNameEnrollmentSteps(q, row.workspaceId, row.userId, row.vmName, now),
  );
  if (pending)
    throw new Error(
      `${row.vmName} was created before Paws recorded which tokens a VM enrolls with, and an enrollment token for that name is still valid until ${new Date(pending).toISOString()}. Retry after it expires.`,
    );
}

async function vmRunners(store: Db, row: MemberVm): Promise<MemberVmRunner[]> {
  const enrolled = await store.run((q) => memberVmEnrolledRunnerIdsSteps(q, row.id));
  const ids = new Set(
    [row.deleteRunnerId, row.runnerId, ...enrolled].filter((value) => value !== null),
  );
  const runners: MemberVmRunner[] = [];
  for (const id of ids) {
    const runner = await store.run((q) => liveRunnerSteps(q, id));
    if (runner !== null && runner.workspaceId === row.workspaceId) runners.push(runner);
  }
  return runners;
}

async function advance(store: Db, row: MemberVm, step: MemberVmDeleteStep, at: number) {
  const from = row.deleteStep!;
  if (!(await store.run((q) => advanceMemberVmDeleteSteps(q, row.id, from, step, at))))
    throw new StepMoved();
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
