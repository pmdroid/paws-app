import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { journal, journalCaught } from "../journal";
import type { IssueVmDisks } from "./issue-vm-disks";

const UNIT = /^paws-issue-vm@([0-7][0-9A-HJKMNP-TV-Z]{25})-([0-9]+)-([0-9]+)-([0-9]+)\.service$/;
const ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const MAX_SLOT = 254;
const LIVE = new Set(["active", "activating", "deactivating", "reloading", "refreshing"]);
const KEPT_STATES = new Set(["creating", "awake", "asleep", "unknown"]);
const SLEEP_CHECK_OUTPUT = "/run/paws-issue-vm-sleep-check";
const MAX_REFUSAL = 300;

/**
 * Sent with the unit report so Paws answers with the VM disk size, bootstrap tokens and holds.
 * Runners released before it parse the answer strictly, so Paws adds those only when asked, and
 * a Paws release that doesn't know the query ignores it and answers without them.
 */
export const ISSUE_VM_DISKS_QUERY = "disks=1";

export type IssueVmUnits = {
  active(): Promise<string[]>;
  start(unit: string): Promise<void>;
  stop(unit: string): Promise<void>;
  /** Runs the sign-in check in the VM; null when it may stop, otherwise why not. */
  sleepCheck(unit: string): Promise<string | null>;
};

export type IssueVmMachineSize = { vcpus: number; memoryGb: number };

export type IssueVmMachine = IssueVmMachineSize & { id: string; slot: number; unit: string };

export type IssueVmStopReason = "unknown" | "deleting" | "asleep" | "duplicate" | "over_limit";

export type IssueVmReconcile = {
  kept: IssueVmMachine[];
  stopped: { machine: IssueVmMachine; reason: IssueVmStopReason }[];
  started: IssueVmMachine[];
  waiting: string[];
  refused: { machine: IssueVmMachine; reason: string }[];
  disksRemoved: string[];
};

export type IssueVmSleepRefusal = { id: string; reason: string };

export function issueVmUnit(id: string, slot: number, size: IssueVmMachineSize): string {
  return `paws-issue-vm@${id}-${slot}-${size.vcpus}-${size.memoryGb}.service`;
}

function startable(row: IssueVmHostRow): boolean {
  return (
    row.state === "creating" || (row.want === "awake" && ["awake", "asleep"].includes(row.state))
  );
}

export function runningIssueVmIds(units: string[]): string[] {
  return [...new Set(units.flatMap((unit) => machine(unit)?.id ?? []))].sort();
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

/**
 * Brings the host's units, and its disks when `disks` is given, in line with Paws's view. A
 * creating VM's disk is cloned before its first start, and a disk whose VM Paws lists as deleting
 * or no longer lists is removed once its unit stopped. Both need the VM disk size, which Paws sends
 * only with a unit report that asks for it, except on a runner Paws says is no VM host: there every
 * VM is gone, so once their units stopped all the disks go too.
 */
export async function reconcileIssueVms(
  units: IssueVmUnits,
  host: IssueVmHostView,
  stage?: (id: string, token: string) => void,
  disks?: Pick<IssueVmDisks, "clone" | "list" | "remove"> | null,
): Promise<IssueVmReconcile> {
  const known = host.vmHost ? host.vms : [];
  const rows = new Map(known.map((row) => [row.id, row]));
  const result: IssueVmReconcile = {
    kept: [],
    stopped: [],
    started: [],
    waiting: [],
    refused: [],
    disksRemoved: [],
  };
  const ids = new Set<string>();
  const used = new Set<number>();
  const limit = host.vmHost ? Math.min(host.slots, MAX_SLOT) : 0;
  const running = (await units.active())
    .map(machine)
    .filter((found): found is IssueVmMachine => found !== null)
    .sort((a, b) => a.slot - b.slot || a.unit.localeCompare(b.unit));
  for (const found of running) {
    const row = rows.get(found.id);
    const reason: IssueVmStopReason | null =
      row === undefined
        ? "unknown"
        : !KEPT_STATES.has(row.state)
          ? "deleting"
          : row.want === "asleep" && row.state !== "creating"
            ? "asleep"
            : ids.has(found.id) || used.has(found.slot)
              ? "duplicate"
              : ids.size >= limit
                ? "over_limit"
                : null;
    const refusal = reason === "asleep" ? await sleepRefusal(units, found) : null;
    if (refusal !== null) {
      journal(`issue_vm_sleep_refused vm=${found.id} slot=${found.slot}`);
      result.refused.push({ machine: found, reason: refusal });
    }
    if (reason === null || refusal !== null) {
      ids.add(found.id);
      used.add(found.slot);
      if (refusal === null) result.kept.push(found);
      continue;
    }
    await units.stop(found.unit);
    journal(`issue_vm_stopped vm=${found.id} slot=${found.slot} reason=${reason}`);
    result.stopped.push({ machine: found, reason });
  }
  const diskGb = disks && host.vmHost ? host.size.diskGb : undefined;
  if (disks && (!host.vmHost || diskGb !== undefined)) {
    try {
      const gone = (await disks.list())
        .map((disk) => disk.id)
        .filter((id) => !ids.has(id) && !KEPT_STATES.has(rows.get(id)?.state ?? "gone"));
      if (gone.length > 0) result.disksRemoved = await disks.remove(gone);
      for (const id of result.disksRemoved) journal(`issue_vm_disk_deleted vm=${id}`);
    } catch (error) {
      journalCaught(error, "runner-daemon.reconcileIssueVms.remove", null);
    }
  }
  if (!host.vmHost) return result;
  for (const row of known) {
    if (!startable(row) || ids.has(row.id)) continue;
    if (row.hold === true) {
      journal(`issue_vm_waiting vm=${row.id} reason=enrollment`);
      result.waiting.push(row.id);
      continue;
    }
    if (ids.size >= limit) {
      journal(`issue_vm_waiting vm=${row.id} slots=${limit}`);
      result.waiting.push(row.id);
      continue;
    }
    let slot = 1;
    while (used.has(slot)) slot += 1;
    const size = { vcpus: host.size.vcpus, memoryGb: host.size.memoryGb };
    const started = { id: row.id, slot, ...size, unit: issueVmUnit(row.id, slot, size) };
    try {
      if (disks && diskGb !== undefined && row.state === "creating") {
        const disk = await disks.clone(row.id, { diskGb, memoryGb: size.memoryGb });
        if (!disk.ok) {
          journal(
            `issue_vm_waiting vm=${row.id} reason=${disk.reason} need=${disk.needBytes} free=${disk.freeBytes}`,
          );
          result.waiting.push(row.id);
          continue;
        }
      }
      if (row.token !== undefined) stage?.(row.id, row.token);
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

async function sleepRefusal(units: IssueVmUnits, found: IssueVmMachine): Promise<string | null> {
  try {
    const refusal = await units.sleepCheck(found.unit);
    return refusal === null
      ? null
      : refusal.trim().slice(0, MAX_REFUSAL) || "The sign-in check failed";
  } catch (error) {
    journalCaught(error, "runner-daemon.reconcileIssueVms.sleepCheck", null);
    return "The sign-in check could not run";
  }
}

export function systemdIssueVmUnits(
  spawn: typeof Bun.spawn = Bun.spawn,
  checks = SLEEP_CHECK_OUTPUT,
): IssueVmUnits {
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
    async sleepCheck(unit) {
      if (machine(unit) === null) throw new Error(`${unit} is not an issue VM unit`);
      const instance = unit.slice("paws-issue-vm@".length, -".service".length);
      const ran = await systemctl([
        "start",
        "--no-ask-password",
        `paws-issue-vm-sleep-check@${instance}.service`,
      ]).then(
        () => true,
        () => false,
      );
      if (ran) return null;
      try {
        return readFileSync(join(checks, `${instance}.out`), "utf8").slice(0, MAX_REFUSAL);
      } catch {
        return "The sign-in check in the VM failed";
      }
    },
  };
}

export function createFakeIssueVmUnits() {
  const active = new Set<string>();
  const refusals = new Map<string, string>();
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
    async sleepCheck(unit) {
      calls.push(`check ${unit}`);
      await Promise.resolve();
      return refusals.get(unit) ?? null;
    },
  };
  return { units, active, refusals, calls };
}

const VmId = z.string().regex(ID);

export const IssueVmHostViewSchema = z.discriminatedUnion("vmHost", [
  z.strictObject({ vmHost: z.literal(false) }),
  z.strictObject({
    vmHost: z.literal(true),
    slots: z.number().int().min(0),
    size: z.strictObject({
      vcpus: z.number().int().min(1),
      memoryGb: z.number().int().min(1),
      diskGb: z.number().int().min(10).max(500).optional(),
    }),
    vms: z.array(
      z.strictObject({
        id: VmId,
        state: z.string(),
        want: z.enum(["awake", "asleep"]).optional(),
        token: z
          .string()
          .regex(/^[A-Za-z0-9_-]{16,256}$/)
          .optional(),
        hold: z.literal(true).optional(),
      }),
    ),
  }),
]);

export type IssueVmHostView = z.infer<typeof IssueVmHostViewSchema>;

type IssueVmHostRow = Extract<IssueVmHostView, { vmHost: true }>["vms"][number];
