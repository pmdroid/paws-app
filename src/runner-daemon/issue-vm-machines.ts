import { z } from "zod";
import { journal, journalCaught } from "../journal";

const UNIT = /^paws-issue-vm@([0-7][0-9A-HJKMNP-TV-Z]{25})-([0-9]+)-([0-9]+)-([0-9]+)\.service$/;
const ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const MAX_SLOT = 254;
const LIVE = new Set(["active", "activating", "deactivating", "reloading", "refreshing"]);
const KEPT_STATES = new Set(["creating", "awake", "asleep"]);

export type IssueVmUnits = {
  active(): Promise<string[]>;
  start(unit: string): Promise<void>;
  stop(unit: string): Promise<void>;
};

export type IssueVmMachineSize = { vcpus: number; memoryGb: number };

export type IssueVmMachine = IssueVmMachineSize & { id: string; slot: number; unit: string };

export type IssueVmStopReason = "unknown" | "deleting" | "duplicate" | "over_limit";

export type IssueVmReconcile = {
  kept: IssueVmMachine[];
  stopped: { machine: IssueVmMachine; reason: IssueVmStopReason }[];
  started: IssueVmMachine[];
  waiting: string[];
};

export function issueVmUnit(id: string, slot: number, size: IssueVmMachineSize): string {
  return `paws-issue-vm@${id}-${slot}-${size.vcpus}-${size.memoryGb}.service`;
}

function machine(unit: string): IssueVmMachine | null {
  const match = UNIT.exec(unit);
  if (!match) return null;
  return {
    id: match[1]!,
    slot: Number(match[2]),
    vcpus: Number(match[3]),
    memoryGb: Number(match[4]),
    unit,
  };
}

export async function reconcileIssueVms(
  units: IssueVmUnits,
  host: IssueVmHostView,
): Promise<IssueVmReconcile> {
  const known = host.vmHost ? host.vms : [];
  const states = new Map(known.map((row) => [row.id, row.state]));
  const result: IssueVmReconcile = { kept: [], stopped: [], started: [], waiting: [] };
  const ids = new Set<string>();
  const used = new Set<number>();
  const limit = host.vmHost ? Math.min(host.slots, MAX_SLOT) : 0;
  const running = (await units.active())
    .map(machine)
    .filter((found): found is IssueVmMachine => found !== null)
    .sort((a, b) => a.slot - b.slot || a.unit.localeCompare(b.unit));
  for (const found of running) {
    const state = states.get(found.id);
    const reason: IssueVmStopReason | null =
      state === undefined
        ? "unknown"
        : !KEPT_STATES.has(state)
          ? "deleting"
          : ids.has(found.id) || used.has(found.slot)
            ? "duplicate"
            : ids.size >= limit
              ? "over_limit"
              : null;
    if (reason === null) {
      ids.add(found.id);
      used.add(found.slot);
      result.kept.push(found);
      continue;
    }
    await units.stop(found.unit);
    journal(`issue_vm_stopped vm=${found.id} slot=${found.slot} reason=${reason}`);
    result.stopped.push({ machine: found, reason });
  }
  if (!host.vmHost) return result;
  for (const row of known) {
    if (row.state !== "awake" || ids.has(row.id)) continue;
    if (ids.size >= limit) {
      journal(`issue_vm_waiting vm=${row.id} slots=${limit}`);
      result.waiting.push(row.id);
      continue;
    }
    let slot = 1;
    while (used.has(slot)) slot += 1;
    const started = { id: row.id, slot, ...host.size, unit: issueVmUnit(row.id, slot, host.size) };
    try {
      await units.start(started.unit);
    } catch (error) {
      journalCaught(error, "runner-daemon.reconcileIssueVms.start", null);
      continue;
    }
    journal(`issue_vm_started vm=${row.id} slot=${slot}`);
    ids.add(row.id);
    used.add(slot);
    result.started.push(started);
  }
  return result;
}

export function systemdIssueVmUnits(spawn: typeof Bun.spawn = Bun.spawn): IssueVmUnits {
  const systemctl = async (args: string[]): Promise<string> => {
    const child = spawn(["/usr/bin/systemctl", ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout as ReadableStream).text(),
      new Response(child.stderr as ReadableStream).text(),
    ]);
    if (code !== 0) throw new Error(`systemctl ${args.join(" ")} failed: ${stderr.trim() || code}`);
    return stdout;
  };
  return {
    async active() {
      const listing = await systemctl([
        "list-units",
        "--all",
        "--plain",
        "--no-legend",
        "--no-pager",
        "--type=service",
        "paws-issue-vm@*",
      ]);
      return listing
        .split("\n")
        .map((line) => line.trim().split(/\s+/))
        .filter(([unit, , active]) => unit !== undefined && LIVE.has(active ?? ""))
        .map(([unit]) => unit!);
    },
    async start(unit) {
      await systemctl(["start", "--no-ask-password", unit]);
    },
    async stop(unit) {
      await systemctl(["stop", "--no-ask-password", unit]);
    },
  };
}

export function createFakeIssueVmUnits() {
  const active = new Set<string>();
  const calls: string[] = [];
  const units: IssueVmUnits = {
    async active() {
      await Promise.resolve();
      return [...active];
    },
    async start(unit) {
      calls.push(`start ${unit}`);
      await Promise.resolve();
      active.add(unit);
    },
    async stop(unit) {
      calls.push(`stop ${unit}`);
      await Promise.resolve();
      active.delete(unit);
    },
  };
  return { units, active, calls };
}

const VmId = z.string().regex(ID);

export const IssueVmHostViewSchema = z.discriminatedUnion("vmHost", [
  z.strictObject({ vmHost: z.literal(false) }),
  z.strictObject({
    vmHost: z.literal(true),
    slots: z.number().int().min(0),
    size: z.strictObject({ vcpus: z.number().int().min(1), memoryGb: z.number().int().min(1) }),
    vms: z.array(z.strictObject({ id: VmId, state: z.string() })),
  }),
]);

export type IssueVmHostView = z.infer<typeof IssueVmHostViewSchema>;
