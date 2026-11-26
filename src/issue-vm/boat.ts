import { createHash } from "node:crypto";
import {
  isProvisioningError,
  type BoatProvider,
  type BootstrapClock,
  type EnrolledRunner,
  type ExeDevBootstrap,
  type ExeDevTokenReader,
  type ExeDevVmSize,
  type VmState,
} from "../provisioning";
import { ISSUE_VM_SLEEP_CHECK } from "./sleep-check";
import type { StartQueue } from "./start-queue";

export const BOAT_PREPARE_COMMAND = [
  "sudo chown root:root /opt",
  "sudo systemctl --global mask wireplumber.service pipewire.service pipewire.socket pipewire-pulse.service pipewire-pulse.socket",
  "{ sudo pkill -x wireplumber; sudo pkill -x pipewire-pulse; sudo pkill -x pipewire; true; }",
  "printf '%s\\n' 'vm.overcommit_memory = 1' | sudo tee /etc/sysctl.d/90-paws-overcommit.conf >/dev/null",
  "sudo chmod 0644 /etc/sysctl.d/90-paws-overcommit.conf",
  "sudo sysctl -q -p /etc/sysctl.d/90-paws-overcommit.conf",
  "if getent passwd paws-agent >/dev/null; then sudo mkdir -p /var/lib/paws-agent/.local/share && sudo chown paws-agent:paws-agent /var/lib/paws-agent/.local /var/lib/paws-agent/.local/share && sudo chmod 2770 /var/lib/paws-agent/.local /var/lib/paws-agent/.local/share; fi",
].join(" && ");

export class BoatIssueVmError extends Error {
  readonly code: "retention" | "lost" | "timeout" | "failed";

  constructor(code: BoatIssueVmError["code"], message: string) {
    super(message);
    this.name = "BoatIssueVmError";
    this.code = code;
  }
}

export type BoatIssueVmOptions = {
  boat: BoatProvider;
  bootstrap: ExeDevBootstrap;
  queue: StartQueue;
  readToken: ExeDevTokenReader;
  remember: (name: string, id: string) => void | Promise<void>;
  clock?: BootstrapClock;
  pollMs?: number;
  readyMs?: number;
  sleepMs?: number;
  wakeMs?: number;
  installMs?: number;
};

export type BoatIssueVmCreate = {
  name: string;
  key: string;
  snapshot: string;
  size: ExeDevVmSize;
  mintToken: () => Promise<string>;
};

export type BoatIssueVm = EnrolledRunner & { name: string; id: string };

export type BoatIssueVms = {
  create(input: BoatIssueVmCreate): Promise<BoatIssueVm>;
  sleep(name: string): Promise<void>;
  wake(name: string): Promise<void>;
  remove(name: string): Promise<"deleted" | "missing">;
};

const SYSTEM_CLOCK: BootstrapClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export function createBoatIssueVms(options: BoatIssueVmOptions): BoatIssueVms {
  const { boat, bootstrap, queue } = options;
  const clock = options.clock ?? SYSTEM_CLOCK;
  const pollMs = options.pollMs ?? 1_000;

  async function queueKey(): Promise<string> {
    const token = (await options.readToken())?.trim() ?? "";
    return `boat:${createHash("sha256").update(token).digest("hex").slice(0, 16)}`;
  }

  async function state(name: string): Promise<VmState> {
    try {
      return (await boat.getVm(name)).state;
    } catch (error) {
      if (isProvisioningError(error) && error.code === "missing")
        throw new BoatIssueVmError("lost", `boat no longer lists ${name}.`);
      throw error;
    }
  }

  async function reach(name: string, want: VmState, ms: number, action: string): Promise<void> {
    const deadline = clock.now() + ms;
    for (;;) {
      const seen = await state(name);
      if (seen === want) return;
      if (seen === "error")
        throw new BoatIssueVmError("failed", `boat reported an error for ${name} while ${action}.`);
      if (clock.now() >= deadline)
        throw new BoatIssueVmError(
          "timeout",
          `${name} did not finish ${action} within ${Math.round(ms / 1000)} s.`,
        );
      await clock.sleep(pollMs);
    }
  }

  async function stop(name: string, ms: number): Promise<void> {
    const seen = await state(name);
    if (seen === "stopped") return;
    if (seen !== "stopping") await boat.stopVm(name);
    await reach(name, "stopped", ms, "stopping");
  }

  async function resume(name: string, ms: number): Promise<void> {
    const seen = await state(name);
    if (seen !== "running") {
      if (seen === "stopping") await reach(name, "stopped", ms, "stopping");
      if (seen === "stopping" || seen === "stopped") {
        const key = await queueKey();
        await queue.start(key, () => boat.resumeVm(name));
      }
    }
    await reach(name, "running", ms, "waking");
  }

  async function install(name: string, token: string): Promise<void> {
    const started = await bootstrap.startInstall(name, token);
    if (started === "succeeded") return;
    const deadline = clock.now() + (options.installMs ?? 900_000);
    for (;;) {
      const status = await bootstrap.installStatus(name);
      if (status === "succeeded") return;
      if (status === "failed")
        throw new BoatIssueVmError("failed", `The runner install on ${name} failed.`);
      if (clock.now() >= deadline)
        throw new BoatIssueVmError("timeout", `The runner install on ${name} did not finish.`);
      await clock.sleep(pollMs);
    }
  }

  return {
    async create(input) {
      const key = await queueKey();
      const created = await queue.start(key, () =>
        boat.createVm(input.name, input.size, { key: input.key, from: input.snapshot }),
      );
      await options.remember(input.name, created.id);
      await resume(input.name, options.readyMs ?? 120_000);
      const prepared = await boat.execVm(input.name, BOAT_PREPARE_COMMAND, { timeoutMs: 60_000 });
      if (prepared.exitCode !== 0)
        throw new BoatIssueVmError(
          "failed",
          `Preparing ${input.name} for the runner failed: ${prepared.stderr.trim().slice(0, 300)}`,
        );
      try {
        await stop(input.name, options.sleepMs ?? 60_000);
      } catch (error) {
        if (error instanceof BoatIssueVmError && error.code === "lost")
          throw new BoatIssueVmError(
            "retention",
            `boat deleted ${input.name} when it stopped, so issue VMs can't sleep between turns. Turn zero data retention off for the boat account, then try again.`,
          );
        throw error;
      }
      await resume(input.name, options.wakeMs ?? 120_000);
      await install(input.name, await input.mintToken());
      await bootstrap.stageToken(input.name, await input.mintToken());
      await bootstrap.joinTailnet(input.name);
      const enrolled = await bootstrap.enroll(input.name);
      await bootstrap.startRunner(input.name);
      return { name: input.name, id: created.id, ...enrolled };
    },

    async sleep(name) {
      const seen = await state(name);
      if (seen !== "stopped" && seen !== "stopping") {
        if (seen !== "running")
          throw new BoatIssueVmError("failed", `${name} can't sleep while it is ${seen}.`);
        const checked = await boat.execVm(name, ISSUE_VM_SLEEP_CHECK, { timeoutMs: 60_000 });
        if (checked.exitCode !== 0)
          throw new BoatIssueVmError(
            "failed",
            `${name} can't sleep yet: ${checked.stderr.trim().slice(0, 300) || "the sign-in check failed"}`,
          );
      }
      await stop(name, options.sleepMs ?? 60_000);
    },

    async wake(name) {
      await resume(name, options.wakeMs ?? 120_000);
    },

    async remove(name) {
      return boat.deleteVm(name);
    },
  };
}
