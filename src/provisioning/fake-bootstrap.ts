import {
  BootstrapError,
  type BootstrapStep,
  type EnrolledRunner,
  type ExeDevBootstrap,
  type InstallStatus,
  type StartInstallResult,
} from "./bootstrap";

export type FakeBootstrapCall =
  | { step: "startInstall"; vm: string }
  | { step: "installStatus"; vm: string }
  | { step: "stageToken"; vm: string }
  | { step: "enroll"; vm: string }
  | { step: "startRunner"; vm: string }
  | { step: "resetIdentity"; vm: string };

export type FakeBootstrapOptions = {
  enroll?: (vm: string, token: string) => Promise<EnrolledRunner> | EnrolledRunner;
  installPolls?: number;
};

export type FakeBootstrap = ExeDevBootstrap & {
  readonly calls: FakeBootstrapCall[];
  readonly staged: Map<string, string>;
  readonly tokens: string[];
  readonly installed: Set<string>;
  fail(step: FakeBootstrapCall["step"], message: string, times?: number): void;
  scriptInstallStatus(status: InstallStatus, times?: number): void;
};

const STEP: Record<FakeBootstrapCall["step"], BootstrapStep> = {
  startInstall: "install",
  installStatus: "status",
  stageToken: "token",
  enroll: "enroll",
  startRunner: "start",
  resetIdentity: "reset",
};

export function createFakeBootstrap(options: FakeBootstrapOptions = {}): FakeBootstrap {
  const calls: FakeBootstrapCall[] = [];
  const staged = new Map<string, string>();
  const tokens: string[] = [];
  const installed = new Set<string>();
  const running = new Map<string, number>();
  const failures: { step: FakeBootstrapCall["step"]; message: string; times: number }[] = [];
  const statuses: { status: InstallStatus; times: number }[] = [];
  const enrolled = new Map<string, EnrolledRunner>();

  function record(step: FakeBootstrapCall["step"], vm: string): void {
    calls.push({ step, vm });
    const index = failures.findIndex((entry) => entry.step === step);
    const failure = failures[index];
    if (failure === undefined) return;
    failure.times -= 1;
    if (failure.times <= 0) failures.splice(index, 1);
    throw new BootstrapError(STEP[step], `${vm}: ${failure.message}`);
  }

  function scripted(): InstallStatus | null {
    const next = statuses[0];
    if (next === undefined) return null;
    next.times -= 1;
    if (next.times <= 0) statuses.shift();
    return next.status;
  }

  return {
    calls,
    staged,
    tokens,
    installed,

    fail(step, message, times = 1) {
      failures.push({ step, message, times });
    },

    scriptInstallStatus(status, times = 1) {
      statuses.push({ status, times });
    },

    async startInstall(vm, token): Promise<StartInstallResult> {
      record("startInstall", vm);
      if (installed.has(vm)) return "succeeded";
      if (running.has(vm)) return "running";
      tokens.push(token);
      staged.set(vm, token);
      running.set(vm, options.installPolls ?? 1);
      return "started";
    },

    async installStatus(vm) {
      record("installStatus", vm);
      const status = scripted();
      if (status !== null) {
        if (status === "succeeded") installed.add(vm);
        if (status !== "running") running.delete(vm);
        return status;
      }
      if (installed.has(vm)) return "succeeded";
      const left = running.get(vm);
      if (left === undefined) return "failed";
      if (left > 0) {
        running.set(vm, left - 1);
        return "running";
      }
      running.delete(vm);
      installed.add(vm);
      return "succeeded";
    },

    async stageToken(vm, token) {
      record("stageToken", vm);
      tokens.push(token);
      staged.set(vm, token);
    },

    async enroll(vm) {
      record("enroll", vm);
      const done = enrolled.get(vm);
      if (done !== undefined) {
        staged.delete(vm);
        return done;
      }
      const token = staged.get(vm);
      staged.delete(vm);
      if (token === undefined) throw new BootstrapError("enroll", `${vm}: no token is staged.`);
      const runner = options.enroll
        ? await options.enroll(vm, token)
        : { runnerId: `runner-${vm}`, workspaceId: "workspace" };
      enrolled.set(vm, runner);
      return runner;
    },

    async startRunner(vm) {
      record("startRunner", vm);
    },

    async resetIdentity(vm) {
      record("resetIdentity", vm);
      enrolled.delete(vm);
    },
  };
}
