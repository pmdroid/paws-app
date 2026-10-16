import { readFileSync, statfsSync } from "node:fs";
import { dirname, join } from "node:path";
import { RunnerHostStatusSchema, releaseVersion, type RunnerHostStatus } from "../runner-protocol";

export type RunnerHostSamplerOptions = {
  /** Directory whose filesystem free space is reported. */
  workRoot: string;
  /** Symlink to the installed `releases/<version>` directory. */
  release: string;
  proc?: string;
  osRelease?: readonly string[];
};

/**
 * Reads host metrics for the heartbeat. CPU use is the busy share between two calls, so the
 * first sample has none. Unreadable or invalid values are left out rather than failing.
 */
export function createRunnerHostSampler(options: RunnerHostSamplerOptions) {
  const proc = options.proc ?? "/proc";
  const osRelease = options.osRelease ?? ["/etc/os-release", "/usr/lib/os-release"];
  let previous: { busy: number; total: number } | null = null;
  return (): RunnerHostStatus => {
    const sample: Record<string, unknown> = {};
    attempt(() => {
      const fields = read(join(proc, "stat")).split("\n", 1)[0]!.trim().split(/\s+/);
      if (fields[0] !== "cpu") return;
      // user nice system idle iowait irq softirq steal; guest time is already in user.
      const ticks = fields.slice(1, 9).map(Number);
      if (ticks.length < 4 || !ticks.every(Number.isSafeInteger)) return;
      const total = ticks.reduce((sum, value) => sum + value, 0);
      const busy = total - ticks[3]! - (ticks[4] ?? 0);
      if (previous && total > previous.total && busy >= previous.busy)
        sample.cpuPercent = round(
          Math.min(100, ((busy - previous.busy) / (total - previous.total)) * 100),
        );
      previous = { busy, total };
    });
    attempt(() => {
      const memory = new Map(
        read(join(proc, "meminfo"))
          .split("\n")
          .map((line) => /^(\w+):\s+(\d+) kB$/.exec(line.trim()))
          .filter((match) => match !== null)
          .map((match) => [match[1]!, Number(match[2]) * 1024]),
      );
      sample.memoryTotalBytes = memory.get("MemTotal");
      sample.memoryAvailableBytes = memory.get("MemAvailable");
    });
    attempt(() => {
      const [load1, load5, load15] = read(join(proc, "loadavg")).trim().split(/\s+/).map(Number);
      Object.assign(sample, { load1, load5, load15 });
    });
    attempt(() => {
      const disk = statfs(options.workRoot);
      sample.diskTotalBytes = disk.blocks * disk.bsize;
      sample.diskFreeBytes = disk.bavail * disk.bsize;
    });
    for (const path of osRelease) {
      const text = attempt(() => read(path));
      if (text === undefined) continue;
      for (const line of text.split("\n")) {
        const match = /^(ID|VERSION_ID)=(?:"([^"]*)"|'([^']*)'|(\S*))$/.exec(line.trim());
        if (match)
          sample[match[1] === "ID" ? "osId" : "osVersion"] = match[2] ?? match[3] ?? match[4];
      }
      break;
    }
    sample.runnerVersion = releaseVersion(options.release) ?? undefined;
    const valid: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(RunnerHostStatusSchema.shape)) {
      const parsed = field.safeParse(sample[key]);
      if (parsed.success && parsed.data !== undefined) valid[key] = parsed.data;
    }
    return RunnerHostStatusSchema.parse(valid);
  };
}

function statfs(path: string): { blocks: number; bavail: number; bsize: number } {
  try {
    return statfsSync(path);
  } catch (error) {
    // The work root may not exist yet; its parent is on the same filesystem in practice.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw error;
    return statfs(dirname(path));
  }
}

function read(path: string) {
  return readFileSync(path, "utf8");
}

function attempt<T>(action: () => T): T | undefined {
  try {
    return action();
  } catch {
    return undefined;
  }
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}
