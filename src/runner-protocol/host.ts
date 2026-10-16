import { realpathSync } from "node:fs";
import { z } from "zod";

const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const load = z.number().nonnegative().max(1_000_000);
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[A-Za-z0-9.-]+)?$/;

/** Host sample a runner sends with each heartbeat. Every field is optional for older runners. */
export const RunnerHostStatusSchema = z.strictObject({
  cpuPercent: z.number().min(0).max(100).optional(),
  memoryTotalBytes: bytes.optional(),
  memoryAvailableBytes: bytes.optional(),
  load1: load.optional(),
  load5: load.optional(),
  load15: load.optional(),
  diskTotalBytes: bytes.optional(),
  diskFreeBytes: bytes.optional(),
  osId: z
    .string()
    .regex(/^[a-z0-9._-]{1,64}$/)
    .optional(),
  osVersion: z
    .string()
    .regex(/^[A-Za-z0-9._~+-]{1,64}$/)
    .optional(),
  runnerVersion: z.string().max(128).regex(SEMVER).optional(),
});

export type RunnerHostStatus = z.infer<typeof RunnerHostStatusSchema>;

/** Version of an installed release, read from its `releases/<version>` directory. */
export function releaseVersion(path: string): string | null {
  let resolved: string;
  try {
    resolved = realpathSync(path);
  } catch {
    return null;
  }
  const match = /\/releases\/([^/]+)(?:\/|$)/.exec(resolved);
  return match && match[1]!.length <= 128 && SEMVER.test(match[1]!) ? match[1]! : null;
}
