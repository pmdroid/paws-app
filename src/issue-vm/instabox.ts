import { createHash } from "node:crypto";
import {
  isProvisioningError,
  type BootstrapClock,
  type EnrolledRunner,
  type ExeDevBootstrap,
  type ExeDevTokenReader,
  type InstaBox,
  type InstaBoxPlan,
  type ProviderVm,
} from "../provisioning";
import { ISSUE_VM_SLEEP_CHECK } from "./sleep-check";
import { createProviderIssueVmDriver, type IssueVmDriverOptions } from "./driver";
import type { StartQueue } from "./start-queue";

export const INSTABOX_BOOT_HOOK = "/usr/local/lib/instabox/data-init.d/50-paws-runner";

export const INSTABOX_BOOT_SHELL = `#!/bin/sh
set -eu
root="\${PAWS_BOOT_ROOT:-}"
mkdir -p "$root/lib/modules/$(uname -r)"
if grep -qs ' /proc/sys/kernel/random/boot_id ' "$root/proc/self/mountinfo"; then
  umount "$root/proc/sys/kernel/random/boot_id"
fi
if getent passwd paws-agent >/dev/null; then
  for dir in "$root/var/lib/paws-agent/.local" "$root/var/lib/paws-agent/.local/share"; do
    mkdir -p "$dir"
    chown paws-agent:paws-agent "$dir"
    chmod 2770 "$dir"
  done
fi
`;

export const INSTABOX_PREPARE_COMMAND = [
  "sudo install -d -m 0755 /usr/local/lib/instabox/data-init.d",
  `printf '%s' '${Buffer.from(INSTABOX_BOOT_SHELL).toString("base64")}' | base64 -d | sudo tee ${INSTABOX_BOOT_HOOK} >/dev/null`,
  `sudo chmod 0755 ${INSTABOX_BOOT_HOOK}`,
  `sudo ${INSTABOX_BOOT_HOOK}`,
  "printf '%s\\n' 'vm.overcommit_memory = 1' | sudo tee /etc/sysctl.d/90-paws-overcommit.conf >/dev/null",
  "sudo chmod 0644 /etc/sysctl.d/90-paws-overcommit.conf",
  "sudo sysctl -q -p /etc/sysctl.d/90-paws-overcommit.conf",
].join(" && ");

export class InstaBoxIssueVmError extends Error {
  readonly code: "plan" | "size" | "lost" | "timeout" | "failed";

  constructor(code: InstaBoxIssueVmError["code"], message: string) {
    super(message);
    this.name = "InstaBoxIssueVmError";
    this.code = code;
  }
}

export type InstaBoxIssueVmOptions = {
  instaBox: Omit<InstaBox, "listVms" | "listSizes">;
  bootstrap: ExeDevBootstrap;
  queue: StartQueue;
  readToken: ExeDevTokenReader;
  remember: (name: string, id: string) => void | Promise<void>;
  clock?: BootstrapClock;
  pollMs?: number;
  sleepMs?: number;
  wakeMs?: number;
  installMs?: number;
};

export type InstaBoxIssueVmCreate = {
  name: string;
  key: string;
  snapshot: string;
  size: { cpu?: number; memoryGb?: number };
  mintToken: () => Promise<string>;
};

export type InstaBoxIssueVm = EnrolledRunner & { name: string; id: string };

export type InstaBoxIssueVms = {
  create(input: InstaBoxIssueVmCreate): Promise<InstaBoxIssueVm>;
  sleep(name: string): Promise<void>;
  wake(name: string): Promise<void>;
  remove(name: string): Promise<"deleted" | "missing">;
};

const SYSTEM_CLOCK: BootstrapClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function instaBoxPlanRefusal(
  plan: InstaBoxPlan,
  size: InstaBoxIssueVmCreate["size"],
): InstaBoxIssueVmError | null {
  if (plan.tier === "free")
    return new InstaBoxIssueVmError(
      "plan",
      "InstaBox's free plan stops a machine after 2 hours of running, so issue work would be cut off. Paws runs issue VMs only on a paid InstaBox plan, which has no run-time limit.",
    );
  if (!plan.alwaysOn)
    return new InstaBoxIssueVmError(
      "plan",
      `InstaBox's ${plan.tier} plan doesn't allow turning idle pause off, so an issue VM would pause in the middle of a turn. Use an InstaBox plan that allows always on.`,
    );
  if (size.cpu === undefined && size.memoryGb === undefined) return null;
  const memMiB = (size.memoryGb ?? 0) * 1024;
  if (plan.sizes.some((spec) => spec.vcpus === size.cpu && spec.memMiB === memMiB)) return null;
  const allowed = plan.sizes.map((spec) => `${spec.vcpus} vCPU / ${spec.memMiB / 1024} GB`);
  return new InstaBoxIssueVmError(
    "size",
    `InstaBox's ${plan.tier} plan has no ${size.cpu} vCPU / ${size.memoryGb} GB size. It allows ${allowed.length === 0 ? "no size" : allowed.join(", ")}.`,
  );
}

export function createInstaBoxIssueVms(options: InstaBoxIssueVmOptions): InstaBoxIssueVms {
  const { instaBox, bootstrap, queue } = options;
  const clock = options.clock ?? SYSTEM_CLOCK;
  const pollMs = options.pollMs ?? 1_000;

  async function queueKey(): Promise<string> {
    const token = (await options.readToken())?.trim() ?? "";
    return `instabox:${createHash("sha256").update(token).digest("hex").slice(0, 16)}`;
  }

  async function read(name: string): Promise<ProviderVm> {
    try {
      return await instaBox.getVm(name);
    } catch (error) {
      if (isProvisioningError(error) && error.code === "missing")
        throw new InstaBoxIssueVmError("lost", `InstaBox no longer lists ${name}.`);
      throw error;
    }
  }

  async function reach(
    name: string,
    want: "running" | "stopped",
    ms: number,
    action: string,
    begin: (vm: ProviderVm) => Promise<void>,
  ): Promise<void> {
    const deadline = clock.now() + ms;
    let begun = false;
    for (;;) {
      const vm = await read(name);
      if (vm.state === want) return;
      if (vm.state === "error")
        throw new InstaBoxIssueVmError(
          "failed",
          `InstaBox reported an error for ${name} while ${action}.`,
        );
      if (!begun && (vm.state === "running" || vm.state === "stopped")) {
        begun = true;
        await begin(vm);
        continue;
      }
      if (clock.now() >= deadline)
        throw new InstaBoxIssueVmError(
          "timeout",
          `${name} did not finish ${action} within ${Math.round(ms / 1000)} s.`,
        );
      await clock.sleep(pollMs);
    }
  }

  async function wake(name: string): Promise<void> {
    const key = await queueKey();
    await reach(name, "running", options.wakeMs ?? 120_000, "waking", (vm) =>
      queue.start(key, () =>
        vm.status === "suspended" ? instaBox.resumeVm(name) : instaBox.startVm(name),
      ),
    );
  }

  async function exec(name: string, command: string, step: string): Promise<void> {
    const result = await instaBox.execVm(name, command, { timeoutMs: 60_000 });
    if (result.exitCode !== 0)
      throw new InstaBoxIssueVmError(
        "failed",
        `${step} on ${name} failed: ${result.stderr.trim().slice(0, 300)}`,
      );
  }

  async function install(name: string, token: string): Promise<void> {
    if ((await bootstrap.startInstall(name, token)) === "succeeded") return;
    const deadline = clock.now() + (options.installMs ?? 900_000);
    for (;;) {
      const status = await bootstrap.installStatus(name);
      if (status === "succeeded") return;
      if (status === "failed")
        throw new InstaBoxIssueVmError("failed", `The runner install on ${name} failed.`);
      if (clock.now() >= deadline)
        throw new InstaBoxIssueVmError("timeout", `The runner install on ${name} did not finish.`);
      await clock.sleep(pollMs);
    }
  }

  async function createMachine(input: InstaBoxIssueVmCreate): Promise<string> {
    const key = await queueKey();
    try {
      const created = await queue.start(key, () =>
        instaBox.createVm(input.name, input.size, { key: input.key, from: input.snapshot }),
      );
      return created.id;
    } catch (error) {
      if (isProvisioningError(error) && error.status === 403 && error.detail !== null)
        throw new InstaBoxIssueVmError(
          "plan",
          `InstaBox refused to create ${input.name} with idle pause and the run-time limit off (${error.detail}). Use an InstaBox plan that allows always on and has no run-time limit.`,
        );
      throw error;
    }
  }

  return {
    async create(input) {
      const refusal = instaBoxPlanRefusal(await instaBox.readPlan(), input.size);
      if (refusal !== null) throw refusal;
      const id = await createMachine(input);
      await options.remember(input.name, id);
      await wake(input.name);
      await exec(input.name, INSTABOX_PREPARE_COMMAND, "Preparing the machine for the runner");
      await install(input.name, await input.mintToken());
      await exec(input.name, `sudo ${INSTABOX_BOOT_HOOK}`, "The boot step");
      await bootstrap.stageToken(input.name, await input.mintToken());
      await bootstrap.joinTailnet(input.name);
      const enrolled = await bootstrap.enroll(input.name);
      await bootstrap.startRunner(input.name);
      return { name: input.name, id, ...enrolled };
    },

    async sleep(name) {
      await reach(name, "stopped", options.sleepMs ?? 60_000, "suspending", async () => {
        await exec(name, ISSUE_VM_SLEEP_CHECK, "The sign-in check before sleep");
        await instaBox.suspendVm(name);
      });
    },

    wake,

    async remove(name) {
      return instaBox.deleteVm(name);
    },
  };
}

export function createInstaBoxIssueVmDriver(vms: InstaBoxIssueVms, options: IssueVmDriverOptions) {
  return createProviderIssueVmDriver("instabox", vms, options);
}
