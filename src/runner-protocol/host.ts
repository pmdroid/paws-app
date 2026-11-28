import { z } from "zod";

const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const load = z.number().nonnegative().max(1_000_000);
const releaseVersion = z
  .string()
  .max(32)
  .regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/);
/** mise uses calendar versions such as `2026.10.18`. */
const miseVersion = z
  .string()
  .max(32)
  .regex(/^[0-9]{4}\.(0|[1-9][0-9]?)\.(0|[1-9][0-9]{0,3})$/);
const osField = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._~+-]+$/);

/** A process running as the runner user outside the runner's own process tree. */
export const RunnerStrayProcessSchema = z.strictObject({
  pid: z
    .number()
    .int()
    .min(2)
    .max(2 ** 31),
  /** The kernel's short process name, never the command line, which can hold secrets. */
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[\x20-\x7e]+$/),
  ageSeconds: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  /** Percent of one core, so a busy multithreaded process can pass 100. */
  cpuPercent: z.number().min(0).max(409_600),
});

export type RunnerStrayProcess = z.infer<typeof RunnerStrayProcessSchema>;

export const RUNNER_AGENT_USERS = ["runner", "paws-agent"] as const;
export type RunnerAgentUser = (typeof RUNNER_AGENT_USERS)[number];

/** Host sample a runner sends with its heartbeat. The runner leaves out each field it cannot read. */
export const RunnerHostStatusSchema = z.strictObject({
  cpuPercent: z.number().min(0).max(100).optional(),
  /** Online CPUs, so load can be read against the core count. */
  cpuCount: z.number().int().min(1).max(4096).optional(),
  memoryTotalBytes: bytes.optional(),
  memoryAvailableBytes: bytes.optional(),
  load1: load.optional(),
  load5: load.optional(),
  load15: load.optional(),
  diskTotalBytes: bytes.optional(),
  diskFreeBytes: bytes.optional(),
  osId: osField.optional(),
  osVersion: osField.optional(),
  runnerVersion: releaseVersion.optional(),
  /** Version of the mise binary shipped next to the runner. */
  miseVersion: miseVersion.optional(),
  strayProcesses: z.array(RunnerStrayProcessSchema).max(20).optional(),
  agentUser: z.enum(RUNNER_AGENT_USERS).optional(),
  healthFailure: z.string().min(1).max(500).nullable().optional(),
});

export type RunnerHostStatus = z.infer<typeof RunnerHostStatusSchema>;

/** The version from `mise --version` output such as `2026.10.18 linux-x64 (2026-10-23)`. */
export function miseVersionFromOutput(output: string): string | null {
  const parsed = miseVersion.safeParse(output.trim().split(/\s+/, 1)[0]);
  return parsed.success ? parsed.data : null;
}

/** Release version from an installed path such as `/opt/paws-runner/releases/1.2.3/bin/bun`. */
export function releaseVersionFromPath(path: string): string | null {
  const match = /\/releases\/([^/]+)\//.exec(path.endsWith("/") ? path : `${path}/`);
  const parsed = releaseVersion.safeParse(match?.[1]);
  return parsed.success ? parsed.data : null;
}

/** Where the runner's metrics exporter listens: `http://<private or Tailscale address>:<port>/metrics`. */
export const RunnerMetricsSchema = z.strictObject({ url: z.string().max(256) });

function privateHost(hostname: string): boolean {
  const ula = /^\[f[cd][0-9a-f]{0,2}:[0-9a-f:.]*\]$/i.test(hostname);
  const octets = hostname.split(".").map(Number);
  if (ula) return true;
  if (octets.length !== 4 || !/^[0-9.]+$/.test(hostname)) return false;
  const [a, b] = octets as [number, number];
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/** The `host:port` scrape target of a reported metrics URL, or null when Paws ignores it. */
export function runnerMetricsTarget(value: unknown): string | null {
  const parsed = RunnerMetricsSchema.safeParse(value);
  if (!parsed.success || !URL.canParse(parsed.data.url)) return null;
  const url = new URL(parsed.data.url);
  const port = Number(url.port || "80");
  if (
    url.protocol !== "http:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname !== "/metrics" ||
    !(port >= 1 && port <= 65_535) ||
    !privateHost(url.hostname)
  )
    return null;
  return `${url.hostname}:${port}`;
}
