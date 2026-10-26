import { journalCaught } from "../journal";
import { readdirSync, readFileSync, realpathSync, statfsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  RunnerHostStatusSchema,
  miseVersionFromOutput,
  releaseVersionFromPath,
  type RunnerHostStatus,
  type RunnerStrayProcess,
} from "../runner-protocol";

export type RunnerHostSamplerOptions = {
  /** Directory whose filesystem holds runner work. Disk free is reported for it. */
  workRoot: string;
  procRoot?: string;
  osRelease?: string;
  executable?: string;
  /** The packaged mise. Defaults to `mise` next to the resolved runner executable. */
  mise?: string;
  /** The runner process. Processes of its user outside its tree are reported as strays. */
  rootPid?: number;
  uid?: number;
};

type CpuTicks = { idle: number; total: number };

/** Reads host metrics on Linux. CPU percent needs two samples, so the first heartbeat omits it. */
export function createRunnerHostSampler(options: RunnerHostSamplerOptions) {
  const proc = options.procRoot ?? "/proc";
  let previous: CpuTicks | undefined;
  const strays = createStraySampler(
    proc,
    options.rootPid ?? process.pid,
    options.uid ?? process.getuid?.() ?? -1,
  );
  const mise = createMiseVersionProbe();
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
    sample.miseVersion = mise(
      options.mise ??
        attempt(() => join(dirname(realpathSync(options.executable ?? process.execPath)), "mise")),
    );
    sample.strayProcesses = attempt(strays);
    const kept: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(sample)) {
      const field = RunnerHostStatusSchema.shape[name as keyof typeof RunnerHostStatusSchema.shape];
      if (value !== undefined && field?.safeParse(value).success) kept[name] = value;
    }
    return kept as RunnerHostStatus;
  };
}

/**
 * Runs `mise --version` once per resolved binary, in the background so a heartbeat never waits
 * on it. Until the answer arrives, and when there is no mise, the version is undefined. A failed
 * run is tried again on the next sample. The run starts in `/` with a fixed environment so no repository or user mise config is read.
 */
export function createMiseVersionProbe(spawn: typeof Bun.spawn = Bun.spawn) {
  let probed: string | undefined;
  let version: string | undefined;
  return (path: string | undefined): string | undefined => {
    const binary = path && attempt(() => realpathSync(path));
    if (!binary) return undefined;
    if (binary === probed) return version;
    probed = binary;
    version = undefined;
    void (async () => {
      const child = spawn([binary, "--version"], {
        cwd: "/",
        env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", LANG: "C" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        timeout: 10_000,
      });
      const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      const parsed = code === 0 ? miseVersionFromOutput(output) : null;
      if (probed !== binary) return;
      if (parsed) version = parsed;
      else probed = undefined;
    })().catch((caughtError1) => {
      journalCaught(caughtError1, "host.createMiseVersionProbe.spawn", null);
      if (probed === binary) probed = undefined;
    });
    return undefined;
  };
}

/** Linux reports process times in USER_HZ, which is 100 on every supported architecture. */
const TICKS_PER_SECOND = 100;

type ProcessStat = { pid: number; name: string; parent: number; started: number; ticks: number };

function processStat(proc: string, entry: string): ProcessStat | undefined {
  const stat = readFileSync(join(proc, entry, "stat"), "utf8");
  const open = stat.indexOf("(");
  const close = stat.lastIndexOf(")");
  if (open < 0 || close < open) return undefined;
  const fields = stat.slice(close + 2).split(" ");
  if (fields[0] === "Z" || fields[0] === "X") return undefined;
  const name = stat.slice(open + 1, close).replace(/[^\x20-\x7e]/g, "?") || "?";
  return {
    pid: Number(entry),
    name,
    parent: Number(fields[1]),
    started: Number(fields[19]),
    ticks: Number(fields[11]) + Number(fields[12]),
  };
}

/**
 * Processes of the runner user that are not below the runner process, busiest first. A run's
 * processes all descend from the runner, so anything else of that user outlived its run.
 * CPU is measured since the previous sample, or over the process lifetime on first sight.
 */
export function createStraySampler(proc: string, rootPid: number, uid: number) {
  let previous = new Map<string, { ticks: number; at: number }>();
  return (): RunnerStrayProcess[] => {
    const uptime = Number(readFileSync(join(proc, "uptime"), "utf8").split(" ")[0]);
    if (!Number.isFinite(uptime)) throw new Error("Unreadable uptime");
    const table = new Map<number, ProcessStat>();
    const owned = new Set<number>();
    for (const entry of readdirSync(proc)) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = processStat(proc, entry);
        if (!stat) continue;
        table.set(stat.pid, stat);
        if (statSync(join(proc, entry)).uid === uid) owned.add(stat.pid);
      } catch (caughtError2) {
        journalCaught(caughtError2, "host.createStraySampler.processStat", null);
      }
    }
    const insideRunner = (pid: number) => {
      for (let current: number | undefined = pid, hops = 0; current && hops < 4096; hops += 1) {
        if (current === rootPid) return true;
        current = table.get(current)?.parent;
      }
      return false;
    };
    const seen = new Map<string, { ticks: number; at: number }>();
    const found: RunnerStrayProcess[] = [];
    for (const pid of owned) {
      const stat = table.get(pid)!;
      if (pid <= 1 || insideRunner(pid)) continue;
      const key = `${pid}:${stat.started}`;
      seen.set(key, { ticks: stat.ticks, at: uptime });
      const age = Math.max(0, uptime - stat.started / TICKS_PER_SECOND);
      const before = previous.get(key);
      const busy =
        before && uptime > before.at
          ? (stat.ticks - before.ticks) / TICKS_PER_SECOND / (uptime - before.at)
          : age > 0
            ? stat.ticks / TICKS_PER_SECOND / age
            : 0;
      found.push({
        pid,
        name: stat.name,
        ageSeconds: Math.floor(age),
        cpuPercent: Math.round(Math.min(4096, Math.max(0, busy)) * 1000) / 10,
      });
    }
    previous = seen;
    return found.sort((a, b) => b.cpuPercent - a.cpuPercent || a.pid - b.pid).slice(0, 20);
  };
}

function attempt<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch (caughtError3) {
    journalCaught(caughtError3, "host.attempt.read", null);
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
