import { readFile, statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import { RunnerHostStatusSchema, releaseVersion, type RunnerHostStatus } from "../runner-protocol";

type CpuTimes = { busy: number; total: number };

/**
 * Reads host metrics for the heartbeat. CPU is the busy share since the previous sample, so the
 * first sample has none. A file that is missing or unreadable leaves its fields out.
 */
export function createHostSampler(options: {
  workRoot: string;
  procRoot?: string;
  osRelease?: string;
  executable?: string;
}) {
  const proc = options.procRoot ?? "/proc";
  const osRelease = options.osRelease ?? "/etc/os-release";
  const executable = options.executable ?? process.execPath;
  let previous: CpuTimes | null = null;
  async function text(path: string) {
    try {
      return await readFile(path, "utf8");
    } catch {
      return null;
    }
  }
  return async function sample(): Promise<RunnerHostStatus> {
    const [stat, meminfo, loadavg, release, disk] = await Promise.all([
      text(join(proc, "stat")),
      text(join(proc, "meminfo")),
      text(join(proc, "loadavg")),
      text(osRelease),
      statfs(options.workRoot).catch(() => null),
    ]);
    const result: RunnerHostStatus = {};
    const cpu = stat === null ? null : cpuTimes(stat);
    if (cpu && previous && cpu.total > previous.total && cpu.busy >= previous.busy)
      result.cpuPercent = round(
        Math.min(100, ((cpu.busy - previous.busy) / (cpu.total - previous.total)) * 100),
      );
    if (cpu) previous = cpu;
    if (meminfo !== null) {
      const total = kilobytes(meminfo, "MemTotal");
      const available = kilobytes(meminfo, "MemAvailable");
      if (total !== null) result.memoryTotalBytes = total;
      if (available !== null) result.memoryAvailableBytes = available;
    }
    const loads = loadavg?.trim().split(/\s+/).slice(0, 3).map(Number);
    if (loads?.length === 3 && loads.every((value) => Number.isFinite(value) && value >= 0))
      [result.load1, result.load5, result.load15] = loads;
    if (disk) {
      // Block counts are in fragment units; bsize is only the preferred I/O size.
      const unit = (disk as { frsize?: number }).frsize || disk.bsize;
      result.diskTotalBytes = disk.blocks * unit;
      result.diskFreeBytes = disk.bavail * unit;
    }
    if (release !== null) {
      const fields = osReleaseFields(release);
      if (fields.ID) result.osId = fields.ID;
      if (fields.VERSION_ID) result.osVersion = fields.VERSION_ID;
    }
    const version = releaseVersion(dirname(dirname(executable)));
    if (version) result.runnerVersion = version;
    // Drop any field that falls outside the protocol bounds instead of failing the heartbeat.
    return Object.fromEntries(
      Object.entries(result).filter(
        ([key, value]) => RunnerHostStatusSchema.safeParse({ [key]: value }).success,
      ),
    );
  };
}

function cpuTimes(stat: string): CpuTimes | null {
  const line = stat.split("\n", 1)[0]!;
  const parts = line.trim().split(/\s+/);
  if (parts[0] !== "cpu" || parts.length < 5) return null;
  // user nice system idle iowait irq softirq steal; guest time is already counted in user.
  const values = parts.slice(1, 9).map(Number);
  if (!values.every((value) => Number.isSafeInteger(value) && value >= 0)) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  const idle = values[3]! + (values[4] ?? 0);
  return { busy: total - idle, total };
}

function kilobytes(meminfo: string, key: string) {
  const match = new RegExp(`^${key}:\\s+(\\d+) kB$`, "m").exec(meminfo);
  if (!match) return null;
  const value = Number(match[1]) * 1024;
  return Number.isSafeInteger(value) ? value : null;
}

function osReleaseFields(content: string) {
  const fields: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const match = /^(ID|VERSION_ID)=(.*)$/.exec(line.trim());
    if (match) fields[match[1]!] = match[2]!.replace(/^(["'])(.*)\1$/, "$2");
  }
  return fields;
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}
