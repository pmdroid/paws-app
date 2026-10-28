import { journalCaught } from "../journal";
import { sizeRefused } from "./client";
import { adoptVmCommand, assertCommand, assertVmName, newVmCommand } from "./names";
import {
  ProvisioningError,
  type ExeDev,
  type ExeDevCreatedVm,
  type ExeDevExecResult,
  type ExeDevPool,
  type ExeDevVm,
  type ProvisioningErrorCode,
  type ProvisioningOperation,
} from "./types";

export type FakeExeDevCall =
  /** `command` is the `new` line the real client would send. */
  | { operation: "createVm"; vm: string; command: string | null }
  | { operation: "deleteVm"; vm: string }
  | { operation: "getVm"; vm: string }
  | { operation: "listPools" }
  | { operation: "adoptVm"; vm: string; command: string }
  | { operation: "execVm"; vm: string; command: string; timeoutMs: number | null };

export type FakeExecScript =
  | Partial<ExeDevExecResult>
  | ((command: string, vm: string) => Partial<ExeDevExecResult>);

export type FakeFailure = {
  vm?: string;
  command?: string | RegExp;
  times?: number;
  status?: number | null;
};

export type FakeExeDev = ExeDev & {
  readonly calls: FakeExeDevCall[];
  readonly vms: Map<string, ExeDevVm>;
  /** What `pool list` answers. `new --pool` and `pool adopt` refuse a pool not listed here. */
  readonly pools: Map<string, ExeDevPool>;
  /** The pool each VM was created in or moved to. */
  readonly placement: Map<string, string>;
  addPool(name: string, pool?: Partial<Omit<ExeDevPool, "name">>): ExeDevPool;
  addVm(name: string, vm?: Partial<Omit<ExeDevVm, "name">>): ExeDevVm;
  setStatus(name: string, status: string): void;
  scriptExec(vm: string, command: string | RegExp, result: FakeExecScript | FakeExecScript[]): void;
  fail(operation: ProvisioningOperation, code: ProvisioningErrorCode, failure?: FakeFailure): void;
};

type Script = { vm: string; command: string | RegExp; results: FakeExecScript[] };
type Rule = Required<Pick<FakeFailure, "times">> &
  Omit<FakeFailure, "times"> & { operation: ProvisioningOperation; code: ProvisioningErrorCode };

export const FAKE_UNSCRIPTED_EXIT = 127;

export function createFakeExeDev(): FakeExeDev {
  const calls: FakeExeDevCall[] = [];
  const vms = new Map<string, ExeDevVm>();
  const pools = new Map<string, ExeDevPool>();
  const placement = new Map<string, string>();
  const scripts: Script[] = [];
  const rules: Rule[] = [];

  function addVm(name: string, vm: Partial<Omit<ExeDevVm, "name">> = {}): ExeDevVm {
    const value: ExeDevVm = {
      name,
      status: vm.status ?? "running",
      region: vm.region ?? null,
      sshDest: vm.sshDest ?? `${name}.exe.xyz`,
      httpsUrl: vm.httpsUrl ?? `https://${name}.exe.xyz`,
    };
    vms.set(name, value);
    return value;
  }

  function failIfScripted(operation: ProvisioningOperation, vm: string, command?: string): void {
    const index = rules.findIndex(
      (rule) =>
        rule.operation === operation &&
        rule.times > 0 &&
        (rule.vm === undefined || rule.vm === vm) &&
        (rule.command === undefined || (command !== undefined && matches(rule.command, command))),
    );
    const rule = rules[index];
    if (rule === undefined) return;
    rule.times -= 1;
    if (rule.times <= 0) rules.splice(index, 1);
    throw new ProvisioningError(
      operation,
      rule.code,
      `fake exe.dev ${operation} for ${vm} failed (${rule.code}).`,
      rule.status ?? null,
    );
  }

  function existing(operation: ProvisioningOperation, vm: string): ExeDevVm {
    const found = vms.get(vm);
    if (found !== undefined) return found;
    throw new ProvisioningError(
      operation,
      "missing",
      `fake exe.dev ${operation}: ${vm} is not listed.`,
    );
  }

  /** exe.dev's refusal of a pool it does not know, as the real client reports it. */
  function unknownPool(operation: "createVm" | "adoptVm", pool: string): ProvisioningError {
    return new ProvisioningError(
      operation,
      "unknown",
      `fake exe.dev ${operation}: no pool ${pool}.`,
      422,
      `pool "${pool}" does not exist`,
    );
  }

  return {
    calls,
    vms,
    pools,
    placement,
    addVm,

    addPool(name, pool = {}) {
      const value: ExeDevPool = {
        name,
        region: pool.region ?? null,
        status: pool.status ?? "active",
      };
      pools.set(name, value);
      return value;
    },

    setStatus(name, status) {
      const vm = vms.get(name);
      if (vm === undefined) throw new Error(`fake exe.dev has no VM ${name}`);
      vm.status = status;
    },

    scriptExec(vm, command, result) {
      const results = Array.isArray(result) ? [...result] : [result];
      if (results.length === 0) throw new Error("scriptExec needs at least one result");
      scripts.push({ vm, command, results });
    },

    fail(operation, code, failure = {}) {
      rules.push({ ...failure, operation, code, times: failure.times ?? 1 });
    },

    async createVm(name, size): Promise<ExeDevCreatedVm> {
      const call: Extract<FakeExeDevCall, { operation: "createVm" }> = {
        operation: "createVm",
        vm: String(name),
        command: null,
      };
      calls.push(call);
      const vm = assertVmName("createVm", name);
      const command = newVmCommand(vm, size);
      call.command = command;
      failIfScripted("createVm", vm);
      if (vms.has(vm)) {
        throw new ProvisioningError("createVm", "conflict", `fake exe.dev createVm: ${vm} exists.`);
      }
      const pool = size?.pool;
      if (pool !== undefined && !pools.has(pool))
        throw sizeRefused(
          unknownPool("createVm", pool) as ProvisioningError & { detail: string },
          vm,
          command,
          null,
        );
      const created = addVm(vm);
      if (pool !== undefined) placement.set(vm, pool);
      return { name: created.name, sshDest: created.sshDest, httpsUrl: created.httpsUrl };
    },

    async deleteVm(name) {
      calls.push({ operation: "deleteVm", vm: String(name) });
      const vm = assertVmName("deleteVm", name);
      try {
        failIfScripted("deleteVm", vm);
      } catch (error) {
        if (error instanceof ProvisioningError && error.code === "missing") {
          journalCaught(error, "fake.deleteVm.failIfScripted", null);
          return "missing";
        }
        throw error;
      }
      return vms.delete(vm) ? "deleted" : "missing";
    },

    async listPools() {
      calls.push({ operation: "listPools" });
      failIfScripted("listPools", "");
      return [...pools.values()].map((pool) => ({ ...pool }));
    },

    async adoptVm(name, pool) {
      const call: Extract<FakeExeDevCall, { operation: "adoptVm" }> = {
        operation: "adoptVm",
        vm: String(name),
        command: "",
      };
      calls.push(call);
      call.command = adoptVmCommand(name, pool);
      failIfScripted("adoptVm", name);
      existing("adoptVm", name);
      if (!pools.has(pool)) {
        const refused = unknownPool("adoptVm", pool);
        throw new ProvisioningError(
          "adoptVm",
          refused.code,
          `exe.dev refused moving ${name} to pool ${pool}: ${refused.detail}.`,
          refused.status,
          refused.detail,
        );
      }
      placement.set(name, pool);
    },

    async getVm(name) {
      calls.push({ operation: "getVm", vm: String(name) });
      const vm = assertVmName("getVm", name);
      failIfScripted("getVm", vm);
      return { ...existing("getVm", vm) };
    },

    async execVm(name, command, options = {}) {
      calls.push({
        operation: "execVm",
        vm: String(name),
        command: String(command),
        timeoutMs: options.timeoutMs ?? null,
      });
      const vm = assertVmName("execVm", name);
      const line = assertCommand(command);
      failIfScripted("execVm", vm, line);
      existing("execVm", vm);
      const script = scripts.findLast((entry) => entry.vm === vm && matches(entry.command, line));
      if (script === undefined) {
        return {
          exitCode: FAKE_UNSCRIPTED_EXIT,
          stdout: "",
          stderr: `fake exe.dev: no script for ${line}\n`,
        };
      }
      const next = script.results.length > 1 ? script.results.shift() : script.results[0];
      const result = typeof next === "function" ? next(line, vm) : (next ?? {});
      return {
        exitCode: result.exitCode ?? 0,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    },
  };
}

function matches(pattern: string | RegExp, command: string): boolean {
  if (typeof pattern === "string") return pattern === command;
  pattern.lastIndex = 0;
  return pattern.test(command);
}
