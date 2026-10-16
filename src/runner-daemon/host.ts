import { readFile, realpath, statfs } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  RUNNER_VERSION_PATTERN,
  RunnerHostStatusSchema,
  type RunnerHostStatus,
} from "../runner-protocol";

export type RunnerHostSampler = () => Promise<RunnerHostStatus>;

type CpuTimes = { busy: number; total: number };

/**
 * Reads host metrics for the heartbeat. CPU percent is the busy share of the
 * time between two samples, so the first sample has none. Unreadable sources
 * leave their fields out.
 */
export function createRunnerHostSampler(options: {
  workRoot: string;
  releasePointer?: string;
  procRoot?: string;
  osRelease?: string;
}): RunnerHostSampler {
  const proc = options.procRoot ?? "/proc";
  const osRelease = options.osRelease ?? "/etc/os-release";
  let previous: CpuTimes | undefined;
  return async () => {
    const [stat, meminfo, loadavg, disk, os, version] = await Promise.all([
      text(join(proc, "stat")),
      text(join(proc, "meminfo")),
      text(join(proc, "loadavg")),
      statfs(options.workRoot).catch(() => null),
      text(osRelease),
      options.releasePointer ? releaseVersion(options.releasePointer) : null,
    ]);
    const status: RunnerHostStatus = {};
    const cpu = stat === null ? null : cpuTimes(stat);
    if (cpu && previous && cpu.total > previous.total && cpu.busy >= previous.busy)
      status.cpuPercent = round(
        Math.min(100, ((cpu.busy - previous.busy) / (cpu.total - previous.total)) * 100),
      );
    if (cpu) previous = cpu;
    if (meminfo !== null) {
      const total = memoryKib(meminfo, "MemTotal");
      const available = memoryKib(meminfo, "MemAvailable");
      if (total !== null) status.memoryTotalBytes = total * 1024;
      if (available !== null) status.memoryAvailableBytes = available * 1024;
    }
    const loads = loadavg?.trim().split(/\s+/, 3).map(Number);
    if (loads?.length === 3 && loads.every((value) => Number.isFinite(value) && value >= 0))
      [status.load1, status.load5, status.load15] = loads;
    if (disk) {
      status.diskFreeBytes = disk.bavail * disk.bsize;
      status.diskTotalBytes = disk.blocks * disk.bsize;
    }
    if (os !== null) {
      const fields = osReleaseFields(os);
      if (fields.ID) status.osId = fields.ID;
      if (fields.VERSION_ID) status.osVersion = fields.VERSION_ID;
    }
    if (version) status.runnerVersion = version;
    return validFields(status);
  };
}

/** `X.Y.Z` when `pointer` resolves to `…/releases/X.Y.Z`, otherwise null. */
export async function releaseVersion(pointer: string): Promise<string | null> {
  try {
    const target = await realpath(pointer);
    const name = basename(target);
    return basename(dirname(target)) === "releases" && RUNNER_VERSION_PATTERN.test(name)
      ? name
      : null;
  } catch {
    return null;
  }
}

function cpuTimes(stat: string): CpuTimes | null {
  const line = stat.split("\n", 1)[0]!;
  const parts = line.trim().split(/\s+/);
  if (parts[0] !== "cpu" || parts.length < 5) return null;
  // user nice system idle iowait irq softirq steal; guest time is already in user.
  const values = parts.slice(1, 9).map(Number);
  if (!values.every((value) => Number.isSafeInteger(value) && value >= 0)) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  const idle = values[3]! + (values[4] ?? 0);
  return { busy: total - idle, total };
}

function memoryKib(meminfo: string, key: string): number | null {
  const match = new RegExp(`^${key}:\\s+(\\d+) kB$`, "m").exec(meminfo);
  const value = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(value) ? value : null;
}

function osReleaseFields(content: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    let value = match[2]!;
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    fields[match[1]!] = value;
  }
  return fields;
}

function validFields(status: RunnerHostStatus): RunnerHostStatus {
  const shape = RunnerHostStatusSchema.shape;
  const valid: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(status))
    if (shape[key as keyof typeof shape].safeParse(value).success) valid[key] = value;
  return valid as RunnerHostStatus;
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

async function text(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}
