import {
  emitJobReady,
  enqueueJobOnce,
  errorText,
  issueVmByIdSteps,
  liveIssueVmForItemSteps,
  lockIssueVmSteps,
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
export const ISSUE_VM_FIND_MS = 60_000;
const RETRY_MS = 5_000;
const MAX_STEPS = 12;
const MAX_FAILURE = 500;

export type IssueVmCall = { generation: number; signal: AbortSignal };

export type IssueVmDriver = {
  create(vm: IssueVm, call: IssueVmCall): Promise<{ ref: string; runnerId?: string | null }>;
  sleep(vm: IssueVm, call: IssueVmCall): Promise<void>;
  wake(vm: IssueVm, call: IssueVmCall): Promise<void>;
  find(vm: IssueVm, call: IssueVmCall): Promise<IssueVmFound>;
};

export type IssueVmFound = { state: "awake" | "asleep" | "missing"; ref?: string };

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

const IN_FLIGHT = ["creating", "sleeping", "waking"] as const;
type InFlight = (typeof IN_FLIGHT)[number];

const MISSED: Record<InFlight, string> = {
  creating: "The VM did not start before its deadline",
  sleeping: "The VM did not sleep before its deadline",
  waking: "The VM did not wake before its deadline",
};

const lost = (error: unknown) => (error as { code?: unknown } | null)?.code === "lost";

function* armSteps(q: Q, id: string, now: number) {
  return (yield* reenqueueJobSteps(q, {
    queue: ISSUE_VM_LIFECYCLE_QUEUE,
    jobKey: `${ISSUE_VM_LIFECYCLE_QUEUE}:${id}`,
    payload: { issueVmId: id },
    maxAttempts: 1_000,
    now,
  })).armed;
}

function* moveSteps(q: Q, vm: IssueVm, set: IssueVmMove, now: number) {
  if (!(yield* moveIssueVmSteps(q, { id: vm.id, generation: vm.generation, set, now })))
    return false;
  if (set.state !== undefined) yield* followIssueVmSpendSteps(q, vm.id, set.state, now);
  return true;
}

function* sleepNowSteps(q: Q, vm: IssueVm, now: number) {
  yield* moveSteps(q, vm, { state: "sleeping", deadlineAt: now + ISSUE_VM_SLEEP_MS }, now);
}

const refused = (refusal: IssueVmRefusal): IssueVmReadiness => ({ ok: false, refusal });
const readiness = (vm: IssueVm, ready = false): IssueVmReadiness => ({ ok: true, vm, ready });

export function* requestIssueVmAwakeSteps(q: Q, input: IssueVmRequest) {
  const live = yield* liveIssueVmForItemSteps(q, input.itemId);
  if (live === null) {
    const admission = yield* issueVmAdmissionSteps(q, { ...input, at: input.now });
    if (!admission.ok) return refused(admission);
    const deadlineAt = input.now + ISSUE_VM_CREATE_MS;
    const id = yield* recordIssueVmSteps(q, { ...input, deadlineAt });
    yield* followIssueVmSpendSteps(q, id, "creating", input.now);
    yield* armSteps(q, id, input.now);
    return readiness((yield* issueVmByIdSteps(q, id))!);
  }
  if (live.state === "awake" && live.want === "awake") return readiness(live, true);
  if (live.state === "deleting") return readiness(live);
  if (live.want === "asleep" && live.state !== "creating" && live.state !== "waking") {
    const admission = yield* issueVmWakeAdmissionSteps(q, { ...live, at: input.now });
    if (!admission.ok) return refused(admission);
    if (live.state === "awake") yield* sleepNowSteps(q, live, input.now);
    yield* setIssueVmWantSteps(q, { id: live.id, want: "awake" });
  }
  yield* armSteps(q, live.id, input.now);
  return readiness(live);
}

export function* requestIssueVmAsleepSteps(q: Q, input: { itemId: string; now: number }) {
  const live = yield* liveIssueVmForItemSteps(q, input.itemId);
  if (live === null || live.want === "asleep" || live.state === "deleting") return false;
  yield* setIssueVmWantSteps(q, { id: live.id, want: "asleep" });
  if (live.state === "awake") yield* sleepNowSteps(q, live, input.now);
  yield* armSteps(q, live.id, input.now);
  return true;
}

export type IssueVmLifecycleOptions = {
  drivers: Partial<Record<IssueVmProvider, IssueVmDriver>>;
  now?: () => number;
  retryMs?: number;
};

type Outcome = "again" | "settled";
type Result = { ref: string; runnerId?: string | null } | void;

export function createIssueVmLifecycleHandler(store: Db, options: IssueVmLifecycleOptions) {
  const now = options.now ?? Date.now;
  const retryMs = options.retryMs ?? RETRY_MS;

  async function end(vm: IssueVm, state: "unknown" | "failed", reason: string) {
    const at = now();
    const moved = await store.transaction((q) => moveSteps(q, vm, { state, failure: reason }, at));
    if (moved)
      journal(`issue_vm_${state} vm=${vm.id} item=${vm.itemId} reason=${JSON.stringify(reason)}`);
    return "again" as const;
  }

  async function settle(vm: IssueVm & { state: InFlight }, result: Result): Promise<Outcome> {
    const at = now();
    const outcome = await store.transaction(function* (q) {
      const current = yield* lockIssueVmSteps(q, vm.id);
      if (current === null || current.generation !== vm.generation) return "stale" as const;
      if (at > vm.deadlineAt!) return "late" as const;
      const sleep = vm.state === "sleeping" || current.want === "asleep";
      const next: IssueVmMove =
        vm.state === "sleeping"
          ? { state: "asleep", deadlineAt: null }
          : sleep
            ? { state: "sleeping", deadlineAt: at + ISSUE_VM_SLEEP_MS }
            : { state: "awake", deadlineAt: null };
      const created = result ? { providerRef: result.ref, runnerId: result.runnerId ?? null } : {};
      yield* moveSteps(q, current, { ...next, ...created, attempts: 0, failure: null }, at);
      return "moved" as const;
    });
    if (outcome === "moved") return "again";
    journal(`issue_vm_result_ignored vm=${vm.id} op=${vm.state} reason=${outcome}`);
    return outcome === "late" ? end(vm, "unknown", MISSED[vm.state]) : "again";
  }

  async function perform(vm: IssueVm & { state: InFlight }, driver: IssueVmDriver) {
    const deadline = vm.deadlineAt;
    if (deadline === null || now() >= deadline) return end(vm, "unknown", MISSED[vm.state]);
    const controller = new AbortController();
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.onabort = () => reject(new Error("deadline"));
    });
    const timer = setTimeout(() => controller.abort(), deadline - now());
    const call = { generation: vm.generation, signal: controller.signal };
    const running: Promise<Result> =
      vm.state === "creating"
        ? driver.create(vm, call)
        : vm.state === "sleeping"
          ? driver.sleep(vm, call)
          : driver.wake(vm, call);
    let result: Result;
    try {
      result = await Promise.race([running, aborted]);
    } catch (error) {
      if (!controller.signal.aborted) {
        if (lost(error)) return end(vm, "failed", errorText(error).slice(0, MAX_FAILURE));
        throw error;
      }
      void running.then(
        () => journal(`issue_vm_result_ignored vm=${vm.id} op=${vm.state} reason=aborted`),
        () => undefined,
      );
      return end(vm, "unknown", MISSED[vm.state]);
    } finally {
      clearTimeout(timer);
    }
    return settle(vm, result);
  }

  async function reconcile(vm: IssueVm, driver: IssueVmDriver): Promise<Outcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ISSUE_VM_FIND_MS);
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.onabort = () => reject(new Error("The provider did not answer in time"));
    });
    let found: IssueVmFound;
    try {
      const call = { generation: vm.generation, signal: controller.signal };
      found = await Promise.race([driver.find(vm, call), aborted]);
    } finally {
      clearTimeout(timer);
    }
    const at = now();
    const set: IssueVmMove =
      found.state === "missing"
        ? { state: "failed", failure: "The provider no longer lists the VM" }
        : { state: found.state, deadlineAt: null, attempts: 0, failure: null };
    const ref = found.ref === undefined ? {} : { providerRef: found.ref };
    if (await store.transaction((q) => moveSteps(q, vm, { ...set, ...ref }, at)))
      journal(`issue_vm_reconciled vm=${vm.id} item=${vm.itemId} found=${found.state}`);
    return "again";
  }

  async function step(id: string): Promise<Outcome> {
    const vm = await store.run((q) => issueVmByIdSteps(q, id));
    if (vm === null) return "settled";
    const known = (IN_FLIGHT as readonly string[]).includes(vm.state);
    if (known || vm.state === "unknown") {
      const driver = options.drivers[vm.provider];
      if (driver === undefined) throw new Error(`No issue VM driver for ${vm.provider}`);
      if (!known && now() < (vm.deadlineAt ?? 0) + ISSUE_VM_FIND_MS) return "settled";
      if (!known) return reconcile(vm, driver);
      return perform(vm as IssueVm & { state: InFlight }, driver);
    }
    const at = now();
    const begin = (state: InFlight, ms: number) =>
      store.transaction((q) => moveSteps(q, vm, { state, deadlineAt: at + ms, attempts: 0 }, at));
    if (vm.state === "awake" && vm.want === "asleep") await begin("sleeping", ISSUE_VM_SLEEP_MS);
    else if (vm.state === "asleep" && vm.want === "awake") await begin("waking", ISSUE_VM_WAKE_MS);
    else return "settled";
    return "again";
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

type FakeOp = "create" | "sleep" | "wake" | "find";

export type FakeIssueVm = { ref: string; power: "on" | "off" };

type FakeAround = (run: () => unknown, signal: AbortSignal) => Promise<unknown>;

export type FakeIssueVmDriver = IssueVmDriver & {
  calls: { op: FakeOp; id: string; generation: number }[];
  vms: Map<string, FakeIssueVm>;
  aroundNext(op: FakeOp, around: FakeAround): void;
};

export function createFakeIssueVmDriver(): FakeIssueVmDriver {
  const calls: FakeIssueVmDriver["calls"] = [];
  const vms = new Map<string, FakeIssueVm>();
  let next: { op: FakeOp; around: FakeAround } | null = null;

  async function call<T>(op: FakeOp, vm: IssueVm, given: IssueVmCall, run: () => T): Promise<T> {
    calls.push({ op, id: vm.id, generation: given.generation });
    const planned = next?.op === op ? next : null;
    if (planned) next = null;
    return planned ? ((await planned.around(run, given.signal)) as T) : run();
  }

  function found(id: string): FakeIssueVm {
    const vm = vms.get(id);
    if (vm === undefined)
      throw Object.assign(new Error(`The provider no longer lists ${id}.`), { code: "lost" });
    return vm;
  }

  return {
    calls,
    vms,
    aroundNext(op, around) {
      next = { op, around };
    },
    create: (vm, given) =>
      call("create", vm, given, () => {
        const made = vms.get(vm.id) ?? { ref: `fake-${vms.size + 1}`, power: "on" as const };
        vms.set(vm.id, made);
        return { ref: made.ref };
      }),
    sleep: (vm, given) => call("sleep", vm, given, () => void (found(vm.id).power = "off")),
    wake: (vm, given) => call("wake", vm, given, () => void (found(vm.id).power = "on")),
    find: (vm, given) =>
      call("find", vm, given, (): IssueVmFound => {
        const seen = vms.get(vm.id);
        if (seen === undefined) return { state: "missing" };
        return { state: seen.power === "on" ? "awake" : "asleep", ref: seen.ref };
      }),
  };
}
