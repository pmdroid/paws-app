import type { InstaBox, InstaBoxPlan } from "./instabox";
import { assertCommand, assertVmName } from "./names";
import {
  ProvisioningError,
  type ExeDevVmSize,
  type ProvisioningOperation,
  type VmState,
} from "./types";

type FakeInstaBoxMachine = {
  id: string;
  from: string | null;
  size: ExeDevVmSize | null;
  state: string;
};

export type FakeInstaBoxOptions = {
  plan?: Partial<InstaBoxPlan>;
  now?: () => number;
  startsPerMinute?: number;
  retryAfterSeconds?: number;
  refuseIdlePause?: boolean;
};

export type FakeInstaBox = Omit<InstaBox, "listVms" | "listSizes"> & {
  readonly calls: { operation: string; vm: string; command?: string }[];
  readonly machines: Map<string, FakeInstaBoxMachine>;
  lookup(name: string): string | null;
};

const STATES: Readonly<Record<string, readonly [VmState, string]>> = {
  running: ["running", "running"],
  creating: ["starting", "running"],
  starting: ["starting", "running"],
  resuming: ["starting", "running"],
  suspending: ["stopping", "suspended"],
  suspended: ["stopped", "suspended"],
  stopped: ["stopped", "stopped"],
};

export function createFakeInstaBox(options: FakeInstaBoxOptions = {}): FakeInstaBox {
  const now = options.now ?? (() => Date.now());
  const plan: InstaBoxPlan = {
    tier: "pro",
    alwaysOn: true,
    startsPerMinute: 0,
    sizes: [{ vcpus: 4, memMiB: 8192 }],
    ...options.plan,
  };
  const calls: FakeInstaBox["calls"] = [];
  const machines = new Map<string, FakeInstaBoxMachine>();
  const keys = new Map<string, { name: string; id: string }>();
  const starts: number[] = [];
  let next = 0;

  function machine(operation: ProvisioningOperation, name: string): FakeInstaBoxMachine {
    const found = machines.get(assertVmName(operation, name));
    if (found !== undefined) return found;
    throw new ProvisioningError(operation, "missing", `fake InstaBox: ${name} is gone.`, 404);
  }

  function start(operation: ProvisioningOperation, vm: string): void {
    const at = now();
    while (starts.length > 0 && (starts[0] ?? 0) <= at - 60_000) starts.shift();
    if (options.startsPerMinute !== undefined && starts.length >= options.startsPerMinute)
      throw new ProvisioningError(
        operation,
        "rate_limited",
        `fake InstaBox ${operation} for ${vm} failed with HTTP 429 (rate_limited).`,
        429,
        "quota_exceeded",
        (options.retryAfterSeconds ?? 60) * 1000,
      );
    starts.push(at);
  }

  function move(
    method: string,
    operation: ProvisioningOperation,
    name: string,
    from: readonly string[],
    to: string,
  ): void {
    calls.push({ operation: method, vm: name });
    const found = machine(operation, name);
    if (!from.includes(found.state))
      throw new ProvisioningError(operation, "conflict", `fake InstaBox: ${name} is busy.`, 409);
    if (to !== "suspending") start(operation, name);
    found.state = to;
  }

  return {
    id: "instabox",
    calls,
    machines,

    lookup(name) {
      return machines.get(name)?.id ?? null;
    },

    async createVm(name, size, request) {
      calls.push({ operation: "createVm", vm: name });
      const vm = assertVmName("createVm", name);
      const again = request === undefined ? undefined : keys.get(request.key);
      if (again !== undefined) return again;
      if (options.refuseIdlePause === true)
        throw new ProvisioningError(
          "createVm",
          "unauthorized",
          `fake InstaBox createVm for ${vm} failed with HTTP 403 (unauthorized): spec_not_allowed.`,
          403,
          "spec_not_allowed: always on is not part of this plan",
        );
      start("createVm", vm);
      next += 1;
      const id = `m_${String(next).padStart(26, "0")}`;
      const from = request?.from ?? null;
      machines.set(vm, {
        id,
        from,
        size: size ?? null,
        state: from === null ? "creating" : "stopped",
      });
      if (request !== undefined) keys.set(request.key, { name: vm, id });
      return { name: vm, id };
    },

    async getVm(name) {
      calls.push({ operation: "getVm", vm: name });
      const found = machine("getVm", name);
      const seen = found.state;
      const [state, settled] = STATES[seen] ?? ["unknown", seen];
      found.state = settled;
      return { name, status: seen, state };
    },

    async execVm(name, command) {
      calls.push({ operation: "execVm", vm: name, command });
      assertCommand(command);
      if (machine("execVm", name).state !== "running")
        throw new ProvisioningError("execVm", "conflict", `fake InstaBox: ${name} is asleep.`, 409);
      return { exitCode: 0, stdout: "", stderr: "" };
    },

    async suspendVm(name) {
      move("suspendVm", "stopVm", name, ["running"], "suspending");
    },

    async resumeVm(name) {
      move("resumeVm", "resumeVm", name, ["suspended"], "resuming");
    },

    async startVm(name) {
      move("startVm", "resumeVm", name, ["stopped", "suspended"], "starting");
    },

    async deleteVm(name) {
      calls.push({ operation: "deleteVm", vm: name });
      return machines.delete(assertVmName("deleteVm", name)) ? "deleted" : "missing";
    },

    async readPlan() {
      return plan;
    },
  };
}
