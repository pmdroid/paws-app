const UNIT = /^paws-issue-vm@([0-7][0-9A-HJKMNP-TV-Z]{25})-([0-9]+)-([0-9]+)-([0-9]+)\.service$/;
const ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const MAX_SLOT = 254;
const LIVE = new Set(["active", "activating", "deactivating", "reloading", "refreshing"]);
const ADOPTED_STATES = new Set(["creating", "awake", "asleep"]);

export type IssueVmUnits = {
  active(): Promise<string[]>;
  start(unit: string): Promise<void>;
  stop(unit: string): Promise<void>;
};

export type IssueVmMachineSize = { vcpus: number; memoryGb: number };

export type IssueVmMachine = IssueVmMachineSize & { id: string; slot: number; unit: string };

export type IssueVmStart =
  | { ok: true; machine: IssueVmMachine; started: boolean }
  | { ok: false; reason: "no_slot"; slots: number; running: number };

export type IssueVmKnown = { id: string; state: string };

export type IssueVmStopReason = "unknown" | "deleting" | "duplicate";

export type IssueVmReconcile = {
  adopted: IssueVmMachine[];
  stopped: { machine: IssueVmMachine; reason: IssueVmStopReason }[];
  missing: string[];
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

export function issueVmMachines(units: IssueVmUnits, slots: () => number) {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  async function running(): Promise<IssueVmMachine[]> {
    return (await units.active())
      .map(machine)
      .filter((found): found is IssueVmMachine => found !== null)
      .sort((a, b) => a.slot - b.slot || a.unit.localeCompare(b.unit));
  }

  const start = (id: string, size: IssueVmMachineSize): Promise<IssueVmStart> =>
    serial(async () => {
      if (!ID.test(id)) throw new Error(`Not an issue VM id: ${id}`);
      const machines = await running();
      const existing = machines.find((found) => found.id === id);
      if (existing) return { ok: true, machine: existing, started: false };
      const limit = Math.min(slots(), MAX_SLOT);
      const used = new Set(machines.map((found) => found.slot));
      let slot = 1;
      while (used.has(slot)) slot += 1;
      if (machines.length >= limit || slot > MAX_SLOT)
        return { ok: false, reason: "no_slot", slots: limit, running: machines.length };
      const unit = issueVmUnit(id, slot, size);
      await units.start(unit);
      return { ok: true, machine: { id, slot, ...size, unit }, started: true };
    });

  const stop = (id: string): Promise<IssueVmMachine[]> =>
    serial(async () => {
      const stopped: IssueVmMachine[] = [];
      for (const found of await running()) {
        if (found.id !== id) continue;
        await units.stop(found.unit);
        stopped.push(found);
      }
      return stopped;
    });

  const reconcile = (known: readonly IssueVmKnown[]): Promise<IssueVmReconcile> =>
    serial(async () => {
      const states = new Map(known.map((row) => [row.id, row.state]));
      const result: IssueVmReconcile = { adopted: [], stopped: [], missing: [] };
      const ids = new Set<string>();
      const used = new Set<number>();
      for (const found of await running()) {
        const state = states.get(found.id);
        const reason: IssueVmStopReason | null =
          state === undefined || state === "deleted" || state === "failed"
            ? "unknown"
            : !ADOPTED_STATES.has(state)
              ? "deleting"
              : ids.has(found.id) || used.has(found.slot)
                ? "duplicate"
                : null;
        if (reason === null) {
          ids.add(found.id);
          used.add(found.slot);
          result.adopted.push(found);
          continue;
        }
        await units.stop(found.unit);
        result.stopped.push({ machine: found, reason });
      }
      for (const row of known)
        if (row.state === "awake" && !ids.has(row.id)) result.missing.push(row.id);
      return result;
    });

  return { running: () => serial(running), start, stop, reconcile };
}

export type IssueVmMachines = ReturnType<typeof issueVmMachines>;

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
