import { describe, expect, test } from "bun:test";
import {
  BOAT_PREPARE_COMMAND,
  BoatIssueVmError,
  createBoatIssueVms,
  createStartQueue,
} from "../src/issue-vm";
import {
  createFakeBoat,
  createFakeBootstrap,
  ProvisioningError,
  type FakeBoatOptions,
} from "../src/provisioning";

const SIZE = { cpu: 8, memoryGb: 16 };

function setup(
  boatOptions: FakeBoatOptions = {},
  startsPerMinute = 10,
  maxWaitMs?: number,
  refusal?: string,
) {
  let now = 1_000_000;
  const clock = {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
  const ids = new Map<string, string>();
  const minted: number[] = [];
  const boat = createFakeBoat({
    now: clock.now,
    lookup: (name) => ids.get(name) ?? null,
    ...boatOptions,
  });
  const bound = new Set<string>();
  const bootstrap = createFakeBootstrap({
    enroll: (vm) => {
      bound.add(`vm-${vm}`);
      return { runnerId: `runner-${vm}`, workspaceId: "workspace" };
    },
  });
  const queue = createStartQueue({
    startsPerMinute,
    clock,
    ...(maxWaitMs === undefined ? {} : { maxWaitMs }),
  });
  const vms = createBoatIssueVms({
    boat,
    bootstrap,
    queue,
    readToken: () => "boat_fake-key",
    remember: (name, id) => {
      ids.set(name, id);
    },
    enrollment: async (issueVmId) => {
      await Promise.resolve();
      if (refusal !== undefined) throw new Error(refusal);
      if (bound.has(issueVmId)) return null;
      return { token: `token-${issueVmId}-${minted.push(now)}` };
    },
    clock,
  });
  const create = (name: string) =>
    vms.create({
      name,
      key: `key-${name}`,
      snapshot: "paws-issue-vm",
      size: SIZE,
      issueVmId: `vm-${name}`,
    });
  return { boat, bootstrap, queue, vms, create, minted, now: () => now };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

describe("boat issue VMs", () => {
  test("an issue gets a VM from the snapshot, sleeps, wakes and is deleted", async () => {
    const { boat, bootstrap, vms, create } = setup();
    const vm = await create("pas-1-vm");
    expect(vm).toEqual({
      name: "pas-1-vm",
      id: boat.lookup("pas-1-vm") ?? "",
      runnerId: "runner-pas-1-vm",
      workspaceId: "workspace",
    });
    expect(boat.sandboxes.get("pas-1-vm")).toMatchObject({
      from: "paws-issue-vm",
      size: SIZE,
      state: "ready",
    });
    expect(boat.calls.find((call) => call.operation === "execVm")?.command).toBe(
      BOAT_PREPARE_COMMAND,
    );
    expect(boat.calls.map((call) => call.operation)).toContain("stopVm");
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
    expect(boat.sandboxes.get("pas-1-vm")?.state).toBe("archived");
    await vms.sleep("pas-1-vm");
    expect(boat.calls.filter((call) => call.operation === "stopVm")).toHaveLength(2);

    await vms.wake("pas-1-vm");
    expect(boat.sandboxes.get("pas-1-vm")?.state).toBe("ready");
    await vms.wake("pas-1-vm");
    expect(boat.calls.filter((call) => call.operation === "resumeVm")).toHaveLength(2);

    expect(await vms.remove("pas-1-vm")).toBe("deleted");
    expect(boat.lookup("pas-1-vm")).toBeNull();
    expect(await vms.remove("pas-1-vm")).toBe("missing");
  });

  test("a refused bootstrap token creates no sandbox", async () => {
    const { boat, create } = setup({}, 10, undefined, "The Tailscale key waits for approval.");
    await expect(create("pas-9-vm")).rejects.toThrow("The Tailscale key waits for approval.");
    expect(boat.lookup("pas-9-vm")).toBeNull();
  });

  test("a create retried after its runner enrolled starts that runner without a new token", async () => {
    const { bootstrap, create, minted } = setup();
    bootstrap.fail("startRunner", "the runner service did not start");
    await expect(create("pas-7-vm")).rejects.toThrow("the runner service did not start");
    const count = minted.length;
    const vm = await create("pas-7-vm");
    expect(vm.runnerId).toBe("runner-pas-7-vm");
    expect(minted.length).toBe(count);
  });

  test("a create repeated with the same key reuses the sandbox, even one left asleep", async () => {
    const { boat, vms, create } = setup();
    await create("pas-1-vm");
    await vms.sleep("pas-1-vm");
    const again = await create("pas-1-vm");
    expect(again.id).toBe(boat.lookup("pas-1-vm") ?? "");
    expect(boat.sandboxes.size).toBe(1);
    expect(boat.sandboxes.get("pas-1-vm")?.state).toBe("ready");
  });

  test("the prepare step turns off the desktop services and sets overcommit and .local", () => {
    expect(BOAT_PREPARE_COMMAND).toStartWith("sudo chown root:root /opt && ");
    expect(BOAT_PREPARE_COMMAND).toContain("--global mask wireplumber.service");
    expect(BOAT_PREPARE_COMMAND).toContain("'vm.overcommit_memory = 1'");
    expect(BOAT_PREPARE_COMMAND).toContain("sudo chmod 2770 /var/lib/paws-agent/.local");
    expect(BOAT_PREPARE_COMMAND).not.toContain("169.254.169.254");
  });

  test("a burst over boat's start limit queues on Retry-After instead of failing", async () => {
    const { boat, create, minted, now } = setup({ startsPerMinute: 3, retryAfterSeconds: 20 }, 100);
    const started = now();
    const names = ["pas-1-vm", "pas-2-vm", "pas-3-vm", "pas-4-vm", "pas-5-vm"];
    const vms = await Promise.all(names.map(create));
    expect(vms.map((vm) => vm.name)).toEqual(names);
    expect(boat.sandboxes.size).toBe(5);
    expect(boat.calls.filter((call) => call.operation === "createVm").length).toBeGreaterThan(5);
    expect(now() - started).toBeGreaterThanOrEqual(20_000);
    expect(minted.filter((at) => at > started).length).toBe(names.length);
  });

  test("the queue paces starts to its own minute limit without a 429", async () => {
    const { boat, create, now } = setup({}, 2);
    const started = now();
    await Promise.all(["pas-1-vm", "pas-2-vm", "pas-3-vm"].map(create));
    expect(boat.calls.filter((call) => call.operation === "createVm")).toHaveLength(3);
    expect(now() - started).toBeGreaterThanOrEqual(60_000);
  });

  test("starts on one key wait in order; another key has its own lane", async () => {
    const queue = createStartQueue({ startsPerMinute: 2 });
    const order: string[] = [];
    const first = queue.start("a", async () => order.push("a1"));
    const second = queue.start("a", async () => order.push("a2"));
    await Promise.all([first, second, queue.start("b", async () => order.push("b1"))]);
    expect(order).toEqual(["a1", "b1", "a2"]);
  });

  test("a start held past the wait limit fails as rate_limited and creates nothing", async () => {
    const { boat, create } = setup({ startsPerMinute: 0, retryAfterSeconds: 3600 }, 10, 60_000);
    const error = await rejection(create("pas-1-vm"));
    expect(error).toBeInstanceOf(ProvisioningError);
    expect((error as ProvisioningError).code).toBe("rate_limited");
    expect(boat.sandboxes.size).toBe(0);
  });

  test("Retry-After: 0 still waits and gives up at the wait limit", async () => {
    const { boat, create, now } = setup({ startsPerMinute: 0, retryAfterSeconds: 0 }, 10, 30_000);
    const started = now();
    const error = await rejection(create("pas-1-vm"));
    expect((error as ProvisioningError).code).toBe("rate_limited");
    expect(now() - started).toBeLessThanOrEqual(30_000);
    expect(boat.calls.filter((call) => call.operation === "createVm").length).toBeLessThan(40);
  });

  test("zero data retention stops the create with a clear message", async () => {
    const { bootstrap, create } = setup({ zeroDataRetention: true });
    const error = await rejection(create("pas-1-vm"));
    expect(error).toBeInstanceOf(BoatIssueVmError);
    expect((error as BoatIssueVmError).code).toBe("retention");
    expect((error as Error).message).toContain("Turn zero data retention off");
    expect(bootstrap.calls).toHaveLength(0);
  });

  test("a VM boat no longer lists after sleeping is lost, not awake", async () => {
    const { boat, vms, create } = setup();
    await create("pas-1-vm");
    await vms.sleep("pas-1-vm");
    boat.sandboxes.delete("pas-1-vm");
    const error = await rejection(vms.wake("pas-1-vm"));
    expect((error as BoatIssueVmError).code).toBe("lost");
  });

  test("a wake that doesn't reach running in time times out", async () => {
    const { boat, vms, create } = setup();
    await create("pas-1-vm");
    await vms.sleep("pas-1-vm");
    const resume = boat.resumeVm;
    boat.resumeVm = async (name) => {
      await resume(name);
      boat.setState(name, "cloning");
    };
    const error = await rejection(vms.wake("pas-1-vm"));
    expect((error as BoatIssueVmError).code).toBe("timeout");
  });
});
