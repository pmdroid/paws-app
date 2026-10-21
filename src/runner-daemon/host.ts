import { readFileSync, realpathSync, statfsSync } from "node:fs";
import { join } from "node:path";
import {
  RunnerHostStatusSchema,
  releaseVersionFromPath,
  type RunnerHostStatus,
} from "../runner-protocol";

export type RunnerHostSamplerOptions = {
  /** Directory whose filesystem holds runner work. Disk free is reported for it. */
  workRoot: string;
  procRoot?: string;
  osRelease?: string;
  executable?: string;
};

type CpuTicks = { idle: number; total: number };

/** Reads host metrics on Linux. CPU percent needs two samples, so the first heartbeat omits it. */
export function createRunnerHostSampler(options: RunnerHostSamplerOptions) {
  const proc = options.procRoot ?? "/proc";
  let previous: CpuTicks | undefined;
  return (): RunnerHostStatus => {
    const sample: Record<string, unknown> = {};
    const stat = attempt(() => readFileSync(join(proc, "stat"), "utf8"));
    const ticks = stat === undefined ? undefined : cpuTicks(stat);
    if (ticks && previous && ticks.total > previous.total) {
      const busy = 1 - (ticks.idle - previous.idle) / (ticks.total - previous.total);
      sample.cpuPercent = Math.round(Math.min(1, Math.max(0, busy)) * 1000) / 10;
    }
    if (ticks) previous = ticks;
    if (stat !== undefined) sample.cpuCount = cpuCount(stat);
    Object.assign(
      sample,
      attempt(() => memory(readFileSync(join(proc, "meminfo"), "utf8"))),
      attempt(() => loadAverage(readFileSync(join(proc, "loadavg"), "utf8"))),
      attempt(() => {
        const disk = statfsSync(options.workRoot);
        return {
          diskTotalBytes: Number(disk.blocks) * Number(disk.bsize),
          diskFreeBytes: Number(disk.bavail) * Number(disk.bsize),
        };
      }),
      attempt(() => osRelease(readFileSync(options.osRelease ?? "/etc/os-release", "utf8"))),
    );
    const version = attempt(() =>
      releaseVersionFromPath(realpathSync(options.executable ?? process.execPath)),
    );
    if (version) sample.runnerVersion = version;
    const kept: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(sample)) {
      const field = RunnerHostStatusSchema.shape[name as keyof typeof RunnerHostStatusSchema.shape];
      if (value !== undefined && field?.safeParse(value).success) kept[name] = value;
    }
    return kept as RunnerHostStatus;
  };
}

function attempt<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

export function cpuTicks(stat: string): CpuTicks | undefined {
  const line = stat.split("\n").find((entry) => entry.startsWith("cpu "));
  if (!line) return undefined;
  const values = line.trim().split(/\s+/).slice(1, 9).map(Number);
  if (values.length < 4 || values.some((value) => !Number.isSafeInteger(value) || value < 0))
    return undefined;
  // user nice system idle iowait irq softirq steal; guest time is already counted in user.
  return { idle: values[3]! + (values[4] ?? 0), total: values.reduce((sum, value) => sum + value) };
}

/** Online CPUs are the `cpuN` lines; undefined when there are none. */
export function cpuCount(stat: string): number | undefined {
  return stat.split("\n").filter((line) => /^cpu\d+\s/.test(line)).length || undefined;
}

export function memory(meminfo: string) {
  const kib = (name: string) => {
    const match = new RegExp(`^${name}:\\s+(\\d+) kB$`, "m").exec(meminfo);
    return match ? Number(match[1]) * 1024 : undefined;
  };
  return { memoryTotalBytes: kib("MemTotal"), memoryAvailableBytes: kib("MemAvailable") };
}

export function loadAverage(loadavg: string) {
  const [load1, load5, load15] = loadavg.trim().split(/\s+/, 3).map(Number);
  return { load1, load5, load15 };
}

export function osRelease(content: string) {
  const fields: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const match = /^([A-Z_]+)=(?:"([^"]*)"|'([^']*)'|(\S*))\s*$/.exec(line.trim());
    if (match) fields[match[1]!] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return { osId: fields.ID || undefined, osVersion: fields.VERSION_ID || undefined };
}
