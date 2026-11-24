import { assertCommand, assertVmName } from "./names";
import {
  ProvisioningError,
  type BoatProvider,
  type ExeDevVmSize,
  type ProvisioningOperation,
  type VmState,
} from "./types";

export type FakeBoatSandbox = {
  id: string;
  name: string;
  from: string | null;
  size: ExeDevVmSize | null;
  state: string;
};

export type FakeBoatCall = { operation: ProvisioningOperation; vm: string; command?: string };

export type FakeBoatOptions = {
  now?: () => number;
  startsPerMinute?: number;
  retryAfterSeconds?: number;
  zeroDataRetention?: boolean;
  lookup?: (name: string) => string | null;
};

export type FakeBoat = BoatProvider & {
  readonly calls: FakeBoatCall[];
  readonly sandboxes: Map<string, FakeBoatSandbox>;
  lookup(name: string): string | null;
  setState(name: string, state: string): void;
};

const MINUTE = 60_000;

function vmState(state: string): VmState {
  if (state === "ready") return "running";
  if (state === "provisioning") return "starting";
  if (state === "archiving") return "stopping";
  if (state === "archived") return "stopped";
  return state === "error" ? "error" : "unknown";
}

export function createFakeBoat(options: FakeBoatOptions = {}): FakeBoat {
  const now = options.now ?? (() => Date.now());
  const calls: FakeBoatCall[] = [];
  const sandboxes = new Map<string, FakeBoatSandbox>();
  const keys = new Map<string, FakeBoatSandbox>();
  const starts: number[] = [];
  let next = 0;

  function existing(operation: ProvisioningOperation, vm: string): FakeBoatSandbox {
    const id = options.lookup === undefined ? undefined : options.lookup(vm);
    const found = sandboxes.get(vm);
    if (id === null)
      throw new ProvisioningError(operation, "missing", `fake boat ${operation}: no id for ${vm}.`);
    if (found !== undefined && (id === undefined || found.id === id)) return found;
    throw new ProvisioningError(
      operation,
      "missing",
      `fake boat ${operation}: ${vm} is gone.`,
      404,
    );
  }

  function start(operation: ProvisioningOperation, vm: string): void {
    const limit = options.startsPerMinute;
    const at = now();
    while (starts.length > 0 && (starts[0] ?? 0) <= at - MINUTE) starts.shift();
    if (limit !== undefined && starts.length >= limit)
      throw new ProvisioningError(
        operation,
        "rate_limited",
        `fake boat ${operation} for ${vm} failed with HTTP 429 (rate_limited).`,
        429,
        "rate_limited: start limit reached",
        (options.retryAfterSeconds ?? 60) * 1000,
      );
    starts.push(at);
  }

  function conflict(operation: ProvisioningOperation, vm: string, code: string): never {
    throw new ProvisioningError(
      operation,
      "conflict",
      `fake boat ${operation} for ${vm} failed with HTTP 409 (conflict).`,
      409,
      code,
      1000,
    );
  }

  return {
    id: "boat",
    calls,
    sandboxes,

    lookup(name) {
      return sandboxes.get(name)?.id ?? null;
    },

    setState(name, state) {
      existing("getVm", name).state = state;
    },

    async createVm(name, size, request) {
      calls.push({ operation: "createVm", vm: name });
      const vm = assertVmName("createVm", name);
      const again = request === undefined ? undefined : keys.get(request.key);
      if (again !== undefined) return { name: again.name, id: again.id };
      start("createVm", vm);
      next += 1;
      const sandbox: FakeBoatSandbox = {
        id: `bx_fake${String(next).padStart(4, "0")}`,
        name: vm,
        from: request?.from ?? null,
        size: size ?? null,
        state: "provisioning",
      };
      sandboxes.set(vm, sandbox);
      if (request !== undefined) keys.set(request.key, sandbox);
      return { name: vm, id: sandbox.id };
    },

    async getVm(name) {
      calls.push({ operation: "getVm", vm: name });
      const vm = assertVmName("getVm", name);
      const sandbox = existing("getVm", vm);
      const seen = sandbox.state;
      if (seen === "provisioning") sandbox.state = "ready";
      if (seen === "archiving") sandbox.state = "archived";
      return { name: vm, status: seen, state: vmState(seen) };
    },

    async execVm(name, command) {
      calls.push({ operation: "execVm", vm: name, command });
      const vm = assertVmName("execVm", name);
      assertCommand(command);
      if (existing("execVm", vm).state !== "ready") conflict("execVm", vm, "machine_not_running");
      return { exitCode: 0, stdout: "", stderr: "" };
    },

    async stopVm(name) {
      calls.push({ operation: "stopVm", vm: name });
      const vm = assertVmName("stopVm", name);
      const sandbox = existing("stopVm", vm);
      if (sandbox.state !== "ready") conflict("stopVm", vm, "sandbox_not_ready");
      if (options.zeroDataRetention === true) sandboxes.delete(vm);
      else sandbox.state = "archiving";
    },

    async resumeVm(name) {
      calls.push({ operation: "resumeVm", vm: name });
      const vm = assertVmName("resumeVm", name);
      const sandbox = existing("resumeVm", vm);
      if (sandbox.state === "archiving") conflict("resumeVm", vm, "sandbox_stopping");
      if (sandbox.state !== "archived") return;
      start("resumeVm", vm);
      sandbox.state = "provisioning";
    },

    async deleteVm(name) {
      calls.push({ operation: "deleteVm", vm: name });
      const vm = assertVmName("deleteVm", name);
      return sandboxes.delete(vm) ? "deleted" : "missing";
    },
  };
}
