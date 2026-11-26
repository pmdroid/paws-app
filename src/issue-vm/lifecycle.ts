import {
  emitJobReady,
  enqueueJobOnce,
  errorText,
  issueVmByIdSteps,
  lastIssueVmForItemSteps,
  liveIssueVmForItemSteps,
  moveIssueVmSteps,
  noteIssueVmFailureSteps,
  parkLeasedJobSteps,
  reenqueueJobSteps,
  retryLeasedJobSteps,
  setIssueVmWantSteps,
  unsettledIssueVmIdsSteps,
  type Db,
  type IssueVm,
  type IssueVmMove,
  type IssueVmProvider,
  type Job,
  type JobContext,
  type JobLoop,
  type Q,
} from "../db";
import { journal } from "../journal";
import {
  issueVmAdmissionSteps,
  issueVmWakeAdmissionSteps,
  type IssueVmAdmission,
} from "./admission";
import { followIssueVmSpendSteps, recordIssueVmSteps } from "./records";

export const ISSUE_VM_LIFECYCLE_QUEUE = "issue_vm.lifecycle";
export const ISSUE_VM_SWEEP_QUEUE = "issue_vm.sweep";
export const ISSUE_VM_CREATE_MS = 15 * 60_000;
export const ISSUE_VM_SLEEP_MS = 60_000;
export const ISSUE_VM_WAKE_MS = 120_000;
const RETRY_MS = 5_000;
const MAX_STEPS = 12;
const MAX_FAILURE = 500;

export class IssueVmLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IssueVmLostError";
  }
}

export type IssueVmDriver = {
  create(vm: IssueVm): Promise<{ ref: string; runnerId?: string | null }>;
  sleep(vm: IssueVm): Promise<void>;
  wake(vm: IssueVm): Promise<void>;
  remove(vm: IssueVm): Promise<void>;
};

export type IssueVmRequest = {
  workspaceId: string;
  itemId: string;
  memberUserId: string;
  provider: IssueVmProvider;
  hostRunnerId?: string | null;
  now: number;
};

export type IssueVmRefusal = Exclude<IssueVmAdmission, { ok: true }>;

export type IssueVmReadiness =
  | { ok: true; vm: IssueVm; ready: boolean }
  | { ok: false; refusal: IssueVmRefusal };

function lost(error: unknown): boolean {
  return (
    error instanceof IssueVmLostError ||
    (error instanceof Error && (error as { code?: unknown }).code === "lost")
  );
}

function* armSteps(q: Q, id: string, now: number) {
  return (yield* reenqueueJobSteps(q, {
    queue: ISSUE_VM_LIFECYCLE_QUEUE,
    jobKey: `${ISSUE_VM_LIFECYCLE_QUEUE}:${id}`,
    payload: { issueVmId: id },
    maxAttempts: 1_000,
    now,
  })).armed;
}

function* createSteps(q: Q, input: IssueVmRequest, replaces: string | null) {
  const id = yield* recordIssueVmSteps(q, {
    ...input,
    deadlineAt: input.now + ISSUE_VM_CREATE_MS,
    ...(replaces === null ? {} : { replaces }),
  });
  yield* followIssueVmSpendSteps(q, id, "creating", input.now);
  yield* armSteps(q, id, input.now);
  return (yield* issueVmByIdSteps(q, id))!;
}

export function* requestIssueVmAwakeSteps(q: Q, input: IssueVmRequest) {
  const live = yield* liveIssueVmForItemSteps(q, input.itemId);
  if (live === null) {
    const admission = yield* issueVmAdmissionSteps(q, { ...input, at: input.now });
    if (!admission.ok) return { ok: false, refusal: admission } satisfies IssueVmReadiness;
    const last = yield* lastIssueVmForItemSteps(q, input.itemId);
    const vm = yield* createSteps(q, input, last?.id ?? null);
    return { ok: true, vm, ready: false } satisfies IssueVmReadiness;
  }
  if (live.state === "awake" && live.want === "awake")
    return { ok: true, vm: live, ready: true } satisfies IssueVmReadiness;
  if (live.state === "deleting")
    return { ok: true, vm: live, ready: false } satisfies IssueVmReadiness;
  if (live.want === "asleep") {
    if (live.state === "sleeping" || live.state === "asleep") {
      const admission = yield* issueVmWakeAdmissionSteps(q, { ...live, at: input.now });
      if (!admission.ok) return { ok: false, refusal: admission } satisfies IssueVmReadiness;
    }
    yield* setIssueVmWantSteps(q, { id: live.id, want: "awake" });
  }
  yield* armSteps(q, live.id, input.now);
  return { ok: true, vm: { ...live, want: "awake" }, ready: false } satisfies IssueVmReadiness;
}

export function* requestIssueVmAsleepSteps(q: Q, input: { itemId: string; now: number }) {
  const live = yield* liveIssueVmForItemSteps(q, input.itemId);
  if (live === null || live.want === "asleep" || live.state === "deleting") return false;
  yield* setIssueVmWantSteps(q, { id: live.id, want: "asleep" });
  yield* armSteps(q, live.id, input.now);
  return true;
}

export type IssueVmLifecycleOptions = {
  drivers: Partial<Record<IssueVmProvider, IssueVmDriver>>;
  now?: () => number;
  retryMs?: number;
};

type Outcome = "again" | "settled";

export function createIssueVmLifecycleHandler(store: Db, options: IssueVmLifecycleOptions) {
  const now = options.now ?? Date.now;
  const retryMs = options.retryMs ?? RETRY_MS;

  async function move(vm: IssueVm, set: IssueVmMove): Promise<Outcome> {
    const at = now();
    await store.transaction(function* (q) {
      if (!(yield* moveIssueVmSteps(q, { id: vm.id, from: vm, set, now: at }))) return;
      if (set.state !== undefined) yield* followIssueVmSpendSteps(q, vm.id, set.state, at);
    });
    return "again";
  }

  async function replace(vm: IssueVm, driver: IssueVmDriver, reason: string): Promise<Outcome> {
    await driver.remove(vm);
    const at = now();
    const replaced = await store.transaction(function* (q) {
      const failed = { state: "failed", deadlineAt: null, failure: reason } as const;
      if (!(yield* moveIssueVmSteps(q, { id: vm.id, from: vm, set: failed, now: at }))) return null;
      yield* followIssueVmSpendSteps(q, vm.id, "failed", at);
      if (vm.want !== "awake") return vm.id;
      const { workspaceId, itemId, memberUserId, provider, hostRunnerId } = vm;
      const request = { workspaceId, itemId, memberUserId, provider, hostRunnerId, now: at };
      const next = yield* createSteps(q, request, vm.id);
      return next.id;
    });
    if (replaced === null) return "again";
    journal(`issue_vm_lost vm=${vm.id} item=${vm.itemId} reason=${JSON.stringify(reason)}`);
    emitJobReady(store);
    return "settled";
  }

  async function step(id: string): Promise<Outcome> {
    const vm = await store.run((q) => issueVmByIdSteps(q, id));
    if (vm === null || ["deleting", "deleted", "failed"].includes(vm.state)) return "settled";
    const driver = options.drivers[vm.provider];
    if (driver === undefined) throw new Error(`No issue VM driver for ${vm.provider}`);
    const late = vm.deadlineAt !== null && now() > vm.deadlineAt;
    try {
      switch (vm.state) {
        case "creating": {
          if (late) return await replace(vm, driver, "The VM did not start before its deadline");
          const created = await driver.create(vm);
          const asleep = vm.want === "asleep";
          return await move(vm, {
            state: asleep ? "sleeping" : "awake",
            providerRef: created.ref,
            runnerId: created.runnerId ?? null,
            deadlineAt: asleep ? now() + ISSUE_VM_SLEEP_MS : null,
            attempts: 0,
            failure: null,
          });
        }
        case "awake":
          if (vm.want === "awake") return "settled";
          return await move(vm, {
            state: "sleeping",
            deadlineAt: now() + ISSUE_VM_SLEEP_MS,
            attempts: 0,
          });
        case "sleeping":
          if (late) return await replace(vm, driver, "The VM did not sleep before its deadline");
          await driver.sleep(vm);
          return await move(vm, { state: "asleep", deadlineAt: null, attempts: 0, failure: null });
        case "asleep":
          if (vm.want === "asleep") return "settled";
          return await move(vm, {
            state: "waking",
            deadlineAt: now() + ISSUE_VM_WAKE_MS,
            attempts: 0,
          });
        case "waking":
          if (late) return await replace(vm, driver, "The VM did not wake before its deadline");
          await driver.wake(vm);
          return await move(vm, { state: "awake", deadlineAt: null, attempts: 0, failure: null });
      }
      return "settled";
    } catch (error) {
      if (lost(error)) return replace(vm, driver, errorText(error).slice(0, MAX_FAILURE));
      throw error;
    }
  }

  return async (job: Job, context: JobContext): Promise<void> => {
    const payload = job.payload as { issueVmId?: unknown } | null;
    const id = typeof payload?.issueVmId === "string" ? payload.issueVmId : null;
    if (id === null) return;
    for (let count = 0; count < MAX_STEPS; count += 1) {
      if (!(await context.isCurrent())) return;
      let outcome: Outcome;
      try {
        outcome = await step(id);
      } catch (error) {
        const text = errorText(error).slice(0, MAX_FAILURE);
        journal(`issue_vm_retry vm=${id} error=${JSON.stringify(text)}`);
        const at = now();
        await store.transaction(function* (q) {
          yield* noteIssueVmFailureSteps(q, { id, failure: text });
          yield* retryLeasedJobSteps(q, job, at + retryMs, text, 0);
        });
        return;
      }
      if (outcome === "settled") return;
    }
    const at = now();
    await store.run((q) =>
      parkLeasedJobSteps(q, job, { runAt: at, payload: job.payload, attempts: 0, now: at }),
    );
  };
}

export function* armUnsettledIssueVmsSteps(q: Q, now: number) {
  let armed = false;
  for (const id of yield* unsettledIssueVmIdsSteps(q))
    armed = (yield* armSteps(q, id, now)) || armed;
  return armed;
}

export async function registerIssueVmLifecycle(
  jobs: JobLoop,
  options: IssueVmLifecycleOptions,
): Promise<void> {
  const now = options.now ?? Date.now;
  jobs.register(ISSUE_VM_LIFECYCLE_QUEUE, createIssueVmLifecycleHandler(jobs.store, options));
  jobs.register(ISSUE_VM_SWEEP_QUEUE, async () => {
    const at = now();
    if (await jobs.store.transaction((q) => armUnsettledIssueVmsSteps(q, at)))
      emitJobReady(jobs.store);
  });
  await enqueueJobOnce(jobs.store, {
    queue: ISSUE_VM_SWEEP_QUEUE,
    jobKey: ISSUE_VM_SWEEP_QUEUE,
    recurringEveryMs: 30_000,
    now: now(),
  });
}

export type FakeIssueVm = { ref: string; power: "on" | "off" };

export type FakeIssueVmDriver = IssueVmDriver & {
  calls: { op: "create" | "sleep" | "wake" | "remove"; id: string }[];
  vms: Map<string, FakeIssueVm>;
  failNext(
    op: "create" | "sleep" | "wake" | "remove",
    when: "before" | "after",
    error?: Error,
  ): void;
};

export function createFakeIssueVmDriver(): FakeIssueVmDriver {
  const calls: FakeIssueVmDriver["calls"] = [];
  const vms = new Map<string, FakeIssueVm>();
  let failure: { op: string; when: "before" | "after"; error: Error } | null = null;
  let made = 0;

  async function call<T>(op: FakeIssueVmDriver["calls"][number]["op"], id: string, run: () => T) {
    calls.push({ op, id });
    const planned = failure?.op === op ? failure : null;
    if (planned) failure = null;
    if (planned?.when === "before") throw planned.error;
    const result = run();
    if (planned?.when === "after") throw planned.error;
    return result;
  }

  function found(id: string): FakeIssueVm {
    const vm = vms.get(id);
    if (vm === undefined) throw new IssueVmLostError(`The provider no longer lists ${id}.`);
    return vm;
  }

  return {
    calls,
    vms,
    failNext(op, when, error = new Error(`fake ${op} crashed ${when} its effect`)) {
      failure = { op, when, error };
    },
    create: (vm) =>
      call("create", vm.id, () => {
        const existing = vms.get(vm.id);
        if (existing) return { ref: existing.ref };
        made += 1;
        const created = { ref: `fake-${made}`, power: "on" } as FakeIssueVm;
        vms.set(vm.id, created);
        return { ref: created.ref };
      }),
    sleep: (vm) => call("sleep", vm.id, () => void (found(vm.id).power = "off")),
    wake: (vm) => call("wake", vm.id, () => void (found(vm.id).power = "on")),
    remove: (vm) => call("remove", vm.id, () => void vms.delete(vm.id)),
  };
}
