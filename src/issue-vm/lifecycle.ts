import {
  errorText,
  issueVmByIdSteps,
  latestItemIssueVmSteps,
  lockIssueVmSteps,
  moveIssueVmSteps,
  setIssueVmWantSteps,
  sweptIssueVmIdsSteps,
  type Db,
  type IssueVm,
  type IssueVmMove,
  type IssueVmOperation,
  type IssueVmProvider,
  type Q,
} from "../db";
import { journal } from "../journal";
import { issueVmAdmissionSteps, issueVmWakeAdmissionSteps } from "./admission";
import type { IssueVmAdmission } from "./admission";
import { followIssueVmSpendSteps, recordIssueVmSteps } from "./records";

export const ISSUE_VM_DEADLINE_MS: Record<IssueVmOperation, number> = {
  create: 15 * 60_000,
  wake: 120_000,
  sleep: 60_000,
};
export const ISSUE_VM_RECONCILE_MS = 60_000;
const MAX_STEPS = 6;
const MAX_FAILURE = 500;

export type IssueVmCall = { generation: number; signal: AbortSignal };

export type IssueVmFound = "awake" | "asleep" | "missing";

export type IssueVmDriver = {
  create(name: string, call: IssueVmCall): Promise<void>;
  wake(name: string, call: IssueVmCall): Promise<void>;
  sleep(name: string, call: IssueVmCall): Promise<void>;
  delete(name: string, call: IssueVmCall): Promise<void>;
  reconcile(name: string, call: IssueVmCall): Promise<IssueVmFound>;
};

export type IssueVmRequest = {
  workspaceId: string;
  itemId: string;
  memberUserId: string;
  provider: IssueVmProvider;
  hostRunnerId?: string | null;
  now: number;
};

export type IssueVmReadiness =
  | { ok: true; vm: IssueVm; ready: boolean }
  | { ok: false; reason: "failed"; vm: IssueVm }
  | { ok: false; reason: "refused"; refusal: Exclude<IssueVmAdmission, { ok: true }> };

const LIVE = ["creating", "awake", "asleep", "unknown"];

type Refusal = Exclude<IssueVmAdmission, { ok: true }>;
const refused = (refusal: Refusal): IssueVmReadiness => ({ ok: false, reason: "refused", refusal });
const live = (vm: IssueVm, ready = false): IssueVmReadiness => ({ ok: true, vm, ready });

export function* requestIssueVmAwakeSteps(q: Q, input: IssueVmRequest) {
  const latest = yield* latestItemIssueVmSteps(q, input.itemId);
  if (latest?.state === "failed")
    return { ok: false, reason: "failed", vm: latest } as IssueVmReadiness;
  if (latest?.state === "deleting") return live(latest);
  if (latest === null || !LIVE.includes(latest.state)) {
    const admission = yield* issueVmAdmissionSteps(q, { ...input, at: input.now });
    if (!admission.ok) return refused(admission);
    const id = yield* recordIssueVmSteps(q, input);
    return live((yield* issueVmByIdSteps(q, id))!);
  }
  if (latest.want === "asleep") {
    if (latest.state === "asleep") {
      const admission = yield* issueVmWakeAdmissionSteps(q, { ...latest, at: input.now });
      if (!admission.ok) return refused(admission);
    }
    yield* setIssueVmWantSteps(q, { id: latest.id, want: "awake" });
  }
  return live({ ...latest, want: "awake" }, latest.state === "awake" && latest.operation === null);
}

export function* requestIssueVmAsleepSteps(q: Q, input: { itemId: string }) {
  const latest = yield* latestItemIssueVmSteps(q, input.itemId);
  if (latest === null || !LIVE.includes(latest.state) || latest.want === "asleep") return false;
  yield* setIssueVmWantSteps(q, { id: latest.id, want: "asleep" });
  return true;
}

export type IssueVmLifecycleOptions = {
  drivers: Partial<Record<IssueVmProvider, IssueVmDriver>>;
  now?: () => number;
  deadlineMs?: Partial<Record<IssueVmOperation | "reconcile", number>>;
};

export type IssueVmLifecycle = { sweep(): Promise<void> };

const MISSED: Record<IssueVmOperation, string> = {
  create: "The VM was not created before its deadline",
  wake: "The VM did not wake before its deadline",
  sleep: "The VM did not sleep before its deadline",
};

const SETTLED: Record<IssueVmOperation, "awake" | "asleep"> = {
  create: "awake",
  wake: "awake",
  sleep: "asleep",
};

const TIMED_OUT = Symbol("timed out");

function nextOperation(vm: IssueVm): IssueVmOperation | null {
  if (vm.state === "creating") return "create";
  if (vm.state === "awake" && vm.want === "asleep") return "sleep";
  if (vm.state === "asleep" && vm.want === "awake") return "wake";
  return null;
}

export function createIssueVmLifecycle(
  store: Db,
  options: IssueVmLifecycleOptions,
): IssueVmLifecycle {
  const now = options.now ?? Date.now;
  const limits = {
    ...ISSUE_VM_DEADLINE_MS,
    reconcile: ISSUE_VM_RECONCILE_MS,
    ...options.deadlineMs,
  };

  function ignored(vm: IssueVm, op: string, reason: string) {
    journal(`issue_vm_result_ignored vm=${vm.id} op=${op} generation=${vm.generation} ${reason}`);
  }

  async function bounded<T>(
    vm: IssueVm,
    op: string,
    ms: number,
    run: (call: IssueVmCall) => Promise<T>,
  ) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(TIMED_OUT);
      }, ms);
    });
    const running = run({ generation: vm.generation, signal: controller.signal });
    try {
      const result = await Promise.race([running, expired]).catch(
        (error: unknown): typeof TIMED_OUT => {
          if (controller.signal.aborted) return TIMED_OUT;
          throw error;
        },
      );
      if (result === TIMED_OUT)
        void running.then(
          () => ignored(vm, op, "reason=late"),
          () => undefined,
        );
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  async function move(vm: IssueVm, set: IssueVmMove, note: string) {
    const at = now();
    const moved = await store.transaction(function* (q) {
      if (!(yield* moveIssueVmSteps(q, { id: vm.id, generation: vm.generation, set, now: at })))
        return false;
      if (set.state !== undefined) yield* followIssueVmSpendSteps(q, vm.id, set.state, at);
      return true;
    });
    if (moved) journal(`issue_vm_${set.state ?? vm.state} vm=${vm.id} item=${vm.itemId} ${note}`);
    return moved;
  }

  const unknown = (vm: IssueVm, failure: string) =>
    move(
      vm,
      { state: "unknown", failure: failure.slice(0, MAX_FAILURE) },
      `op=${vm.operation} reason=${JSON.stringify(failure.slice(0, MAX_FAILURE))}`,
    );

  async function settle(vm: IssueVm, op: IssueVmOperation) {
    const at = now();
    const outcome = await store.transaction(function* (q) {
      const current = yield* lockIssueVmSteps(q, vm.id);
      if (current === null || current.generation !== vm.generation) return "stale" as const;
      if (at > vm.deadlineAt!) return "late" as const;
      const set = { state: SETTLED[op], operation: null, deadlineAt: null, failure: null };
      if (!(yield* moveIssueVmSteps(q, { id: vm.id, generation: vm.generation, set, now: at })))
        return "ended" as const;
      yield* followIssueVmSpendSteps(q, vm.id, set.state, at);
      return "moved" as const;
    });
    if (outcome === "moved") return journal(`issue_vm_${SETTLED[op]} vm=${vm.id} op=${op}`);
    ignored(vm, op, `reason=${outcome}`);
    if (outcome === "late") await unknown(vm, MISSED[op]);
  }

  async function perform(vm: IssueVm, driver: IssueVmDriver, op: IssueVmOperation) {
    const deadlineAt = now() + limits[op];
    if (!(await move(vm, { operation: op, deadlineAt }, `op=${op}`))) return;
    const begun = { ...vm, operation: op, deadlineAt, generation: vm.generation + 1 };
    try {
      const result = await bounded(begun, op, deadlineAt - now(), (call) =>
        driver[op](vm.id, call),
      );
      if (result === TIMED_OUT) await unknown(begun, MISSED[op]);
      else await settle(begun, op);
    } catch (error) {
      await unknown(begun, errorText(error));
    }
  }

  async function reconcile(vm: IssueVm, driver: IssueVmDriver) {
    const found = await bounded(vm, "reconcile", limits.reconcile, (call) =>
      driver.reconcile(vm.id, call),
    );
    if (found === TIMED_OUT) return false;
    const overdue =
      found === "awake" &&
      (vm.operation === "create" || vm.operation === "wake") &&
      now() > (vm.deadlineAt ?? 0);
    const set: IssueVmMove =
      found === "missing"
        ? { state: "failed", failure: "The provider no longer lists the VM" }
        : overdue
          ? { state: "failed", failure: `The VM woke after its ${vm.operation} deadline` }
          : { state: found, failure: null };
    return move(vm, { ...set, operation: null, deadlineAt: null }, `found=${found}`);
  }

  async function step(id: string) {
    const vm = await store.run((q) => issueVmByIdSteps(q, id));
    if (vm === null || !LIVE.includes(vm.state)) return false;
    const driver = options.drivers[vm.provider];
    if (driver === undefined) throw new Error(`No issue VM driver for ${vm.provider}`);
    if (vm.state === "unknown") return reconcile(vm, driver);
    if (vm.operation !== null) {
      if (now() < (vm.deadlineAt ?? 0)) return false;
      return unknown(vm, MISSED[vm.operation]);
    }
    const op = nextOperation(vm);
    if (op === null) return false;
    await perform(vm, driver, op);
    return true;
  }

  async function advance(id: string) {
    try {
      for (let count = 0; count < MAX_STEPS; count += 1) if (!(await step(id))) return;
    } catch (error) {
      journal(`issue_vm_sweep_failed vm=${id} error=${JSON.stringify(errorText(error))}`);
    }
  }

  return {
    async sweep() {
      const ids = await store.run((q) => sweptIssueVmIdsSteps(q));
      await Promise.all(ids.map(advance));
    },
  };
}

type FakeOp = keyof IssueVmDriver;
type FakeAround = (run: () => unknown, signal: AbortSignal) => Promise<unknown>;

export type FakeIssueVmDriver = IssueVmDriver & {
  calls: { op: FakeOp; name: string; generation: number }[];
  vms: Map<string, "on" | "off">;
  aroundNext(op: FakeOp, around: FakeAround): void;
};

export function createFakeIssueVmDriver(): FakeIssueVmDriver {
  const calls: FakeIssueVmDriver["calls"] = [];
  const vms = new Map<string, "on" | "off">();
  const planned = new Map<FakeOp, FakeAround>();

  async function call<T>(op: FakeOp, name: string, given: IssueVmCall, run: () => T) {
    calls.push({ op, name, generation: given.generation });
    const around = planned.get(op);
    planned.delete(op);
    return around ? ((await around(run, given.signal)) as T) : run();
  }

  function power(name: string, state: "on" | "off") {
    if (!vms.has(name)) throw new Error(`The provider no longer lists ${name}`);
    vms.set(name, state);
  }

  return {
    calls,
    vms,
    aroundNext: (op, around) => void planned.set(op, around),
    create: (name, given) => call("create", name, given, () => void vms.set(name, "on")),
    wake: (name, given) => call("wake", name, given, () => power(name, "on")),
    sleep: (name, given) => call("sleep", name, given, () => power(name, "off")),
    delete: (name, given) => call("delete", name, given, () => void vms.delete(name)),
    reconcile: (name, given) =>
      call("reconcile", name, given, (): IssueVmFound => {
        const seen = vms.get(name);
        return seen === undefined ? "missing" : seen === "on" ? "awake" : "asleep";
      }),
  };
}
