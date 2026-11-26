import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInstaBoxIssueVms,
  createStartQueue,
  INSTABOX_BOOT_HOOK,
  INSTABOX_BOOT_SHELL,
  INSTABOX_PREPARE_COMMAND,
  InstaBoxIssueVmError,
  ISSUE_VM_SLEEP_CHECK,
} from "../src/issue-vm";
import {
  createFakeBootstrap,
  createFakeInstaBox,
  type FakeInstaBoxOptions,
} from "../src/provisioning";

const SIZE = { cpu: 4, memoryGb: 8 };
const SNAPSHOT = "snap_paws-issue-vm";

function setup(boxOptions: FakeInstaBoxOptions = {}, startsPerMinute = 10) {
  let now = 1_000_000;
  const clock = {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
  const instaBox = createFakeInstaBox({ now: clock.now, ...boxOptions });
  const bootstrap = createFakeBootstrap();
  const queue = createStartQueue({ startsPerMinute, clock });
  const remembered = new Map<string, string>();
  const vms = createInstaBoxIssueVms({
    instaBox,
    bootstrap,
    queue,
    readToken: () => "ibk_fake-key",
    remember: (name, id) => {
      remembered.set(name, id);
    },
    clock,
  });
  const create = (name: string, size = SIZE) =>
    vms.create({
      name,
      key: `key-${name}`,
      snapshot: SNAPSHOT,
      size,
      mintToken: async () => `token-${now}`,
    });
  return { instaBox, bootstrap, vms, create, remembered, now: () => now };
}

async function refusal(promise: Promise<unknown>): Promise<InstaBoxIssueVmError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (error instanceof InstaBoxIssueVmError) return error;
  throw new Error(`expected an InstaBoxIssueVmError, got ${String(error)}`);
}

describe("InstaBox issue VMs", () => {
  test("an issue gets a VM from the snapshot, sleeps, wakes and is deleted", async () => {
    const { instaBox, bootstrap, vms, create, remembered } = setup();
    const vm = await create("pas-1-vm");
    const id = instaBox.lookup("pas-1-vm");
    expect(vm).toEqual({
      name: "pas-1-vm",
      id: id ?? "",
      runnerId: "runner-pas-1-vm",
      workspaceId: "workspace",
    });
    expect(remembered.get("pas-1-vm")).toBe(id ?? "");
    expect(instaBox.machines.get("pas-1-vm")).toMatchObject({
      from: SNAPSHOT,
      size: SIZE,
      state: "running",
    });
    expect(instaBox.calls.filter((call) => call.operation === "startVm")).toHaveLength(1);
    expect(
      instaBox.calls.filter((call) => call.operation === "execVm").map((call) => call.command),
    ).toEqual([INSTABOX_PREPARE_COMMAND, `sudo ${INSTABOX_BOOT_HOOK}`]);
    expect(bootstrap.calls.map((call) => call.step)).toEqual([
      "startInstall",
      "installStatus",
      "installStatus",
      "stageToken",
      "joinTailnet",
      "enroll",
      "startRunner",
    ]);

    await vms.sleep("pas-1-vm");
    expect(instaBox.machines.get("pas-1-vm")?.state).toBe("suspended");
    await vms.sleep("pas-1-vm");
    expect(instaBox.calls.filter((call) => call.operation === "suspendVm")).toHaveLength(1);

    await vms.wake("pas-1-vm");
    expect(instaBox.machines.get("pas-1-vm")?.state).toBe("running");
    await vms.wake("pas-1-vm");
    expect(instaBox.calls.filter((call) => call.operation === "resumeVm")).toHaveLength(1);

    expect(await vms.remove("pas-1-vm")).toBe("deleted");
    expect(await vms.remove("pas-1-vm")).toBe("missing");
    expect((await refusal(vms.wake("pas-1-vm"))).code).toBe("lost");
  });

  test("a burst over InstaBox's start limit queues instead of failing", async () => {
    const { instaBox, create, now } = setup({ startsPerMinute: 2, retryAfterSeconds: 20 }, 100);
    const started = now();
    const names = ["pas-1-vm", "pas-2-vm", "pas-3-vm"];
    const vms = await Promise.all(names.map((name) => create(name)));
    expect(vms.map((vm) => vm.name)).toEqual(names);
    expect(instaBox.machines.size).toBe(3);
    expect(now() - started).toBeGreaterThanOrEqual(20_000);
  });

  test("a plan that caps run time or keeps idle pause on is refused before any create", async () => {
    const cases = [
      [{ tier: "free" }, "free plan stops a machine after 2 hours"],
      [{ alwaysOn: false }, "pro plan doesn't allow turning idle pause off"],
    ] as const;
    for (const [plan, message] of cases) {
      const { instaBox, bootstrap, create } = setup({ plan });
      const error = await refusal(create("pas-1-vm"));
      expect(error.code).toBe("plan");
      expect(error.message).toContain(message);
      expect(instaBox.calls.filter((call) => call.operation === "createVm")).toHaveLength(0);
      expect(bootstrap.calls).toHaveLength(0);
    }
  });

  test("InstaBox refusing idle pause off fails the create with the reason and creates nothing", async () => {
    const { instaBox, bootstrap, create, remembered } = setup({ refuseIdlePause: true });
    const error = await refusal(create("pas-1-vm"));
    expect(error.code).toBe("plan");
    expect(error.message).toContain("refused to create pas-1-vm with idle pause");
    expect(error.message).toContain("spec_not_allowed");
    expect(instaBox.machines.size).toBe(0);
    expect(remembered.size).toBe(0);
    expect(bootstrap.calls).toHaveLength(0);
  });

  test("a size the plan doesn't allow is refused, never rounded", async () => {
    const { instaBox, create } = setup({
      plan: {
        sizes: [
          { vcpus: 4, memMiB: 8192 },
          { vcpus: 8, memMiB: 16384 },
        ],
      },
    });
    const error = await refusal(create("pas-1-vm", { cpu: 6, memoryGb: 12 }));
    expect(error.code).toBe("size");
    expect(error.message).toBe(
      "InstaBox's pro plan has no 6 vCPU / 12 GB size. It allows 4 vCPU / 8 GB, 8 vCPU / 16 GB.",
    );
    expect(instaBox.machines.size).toBe(0);
    await create("pas-2-vm", { cpu: 8, memoryGb: 16 });
    expect(instaBox.machines.get("pas-2-vm")?.size).toEqual({ cpu: 8, memoryGb: 16 });
  });
});

describe("InstaBox boot step", () => {
  function boot(root: string, bin: string): void {
    const run = Bun.spawnSync(["sh", join(root, "hook")], {
      env: { PATH: `${bin}:${process.env["PATH"] ?? ""}`, PAWS_BOOT_ROOT: root },
    });
    if (run.exitCode !== 0) throw new Error(run.stderr.toString());
  }

  function tree(root: string): string[] {
    return readdirSync(root, { recursive: true, encoding: "utf8" })
      .sort()
      .map((path) => `${path} ${statSync(join(root, path)).mode.toString(8)}`);
  }

  test("runs both fixes and the .local fix, and a second boot changes nothing", () => {
    const root = mkdtempSync(join(tmpdir(), "paws-instabox-boot-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    mkdirSync(join(root, "proc", "self"), { recursive: true });
    const mountinfo = join(root, "proc", "self", "mountinfo");
    writeFileSync(
      mountinfo,
      "22 1 0:21 / /proc rw - proc proc rw\n90 22 0:5 /boot_id /proc/sys/kernel/random/boot_id ro - tmpfs tmpfs ro\n",
    );
    const log = join(root, "calls.log");
    const stub = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    stub("uname", "echo 6.18.60-instabox");
    stub("getent", "exit 0");
    stub("chown", `echo "chown $*" >> "${log}"`);
    stub(
      "umount",
      `echo "umount $1" >> "${log}"; grep -v ' /proc/sys/kernel/random/boot_id ' "${mountinfo}" > "${mountinfo}.new"; mv "${mountinfo}.new" "${mountinfo}"`,
    );
    writeFileSync(join(root, "hook"), INSTABOX_BOOT_SHELL);

    boot(root, bin);
    expect(statSync(join(root, "lib/modules/6.18.60-instabox")).isDirectory()).toBe(true);
    expect(readFileSync(mountinfo, "utf8")).not.toContain("boot_id");
    for (const dir of ["var/lib/paws-agent/.local", "var/lib/paws-agent/.local/share"])
      expect(statSync(join(root, dir)).mode & 0o7777).toBe(0o2770);
    const first = tree(root).filter((line) => !line.startsWith("calls.log"));
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain(`umount ${root}/proc/sys/kernel/random/boot_id`);

    boot(root, bin);
    expect(tree(root).filter((line) => !line.startsWith("calls.log"))).toEqual(first);
    expect(readFileSync(log, "utf8").split("umount")).toHaveLength(2);
  });
});

test("an InstaBox VM suspends only after its sign-in check passes", async () => {
  const { instaBox, vms, create } = setup();
  await create("pas-1-vm");
  const execVm = instaBox.execVm;
  instaBox.execVm = async () => ({
    exitCode: 1,
    stdout: "",
    stderr: "Agent sign-ins remain: binding-1",
  });
  const refused = await refusal(vms.sleep("pas-1-vm"));
  expect(refused.message).toContain("Agent sign-ins remain: binding-1");
  expect(instaBox.machines.get("pas-1-vm")?.state).toBe("running");
  instaBox.execVm = async () => {
    throw new Error("exec timed out");
  };
  expect(await vms.sleep("pas-1-vm").then(() => null, String)).toContain("exec timed out");
  expect(instaBox.machines.get("pas-1-vm")?.state).toBe("running");
  instaBox.execVm = execVm;
  await vms.sleep("pas-1-vm");
  expect(instaBox.calls.filter((call) => call.operation === "execVm").at(-1)?.command).toBe(
    ISSUE_VM_SLEEP_CHECK,
  );
  expect(instaBox.machines.get("pas-1-vm")?.state).toBe("suspended");
});
