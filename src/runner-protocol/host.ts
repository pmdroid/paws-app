import { z } from "zod";

const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const load = z.number().nonnegative().max(1_000_000);
const releaseVersion = z
  .string()
  .max(32)
  .regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/);
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

/** Host sample a runner sends with its heartbeat. Every field is optional so older runners stay valid. */
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
  strayProcesses: z.array(RunnerStrayProcessSchema).max(20).optional(),
});

export type RunnerHostStatus = z.infer<typeof RunnerHostStatusSchema>;

/** Release version from an installed path such as `/opt/paws-runner/releases/1.2.3/bin/paws-runner`. */
export function releaseVersionFromPath(path: string): string | null {
  const match = /\/releases\/([^/]+)\//.exec(path.endsWith("/") ? path : `${path}/`);
  const parsed = releaseVersion.safeParse(match?.[1]);
  return parsed.success ? parsed.data : null;
}
