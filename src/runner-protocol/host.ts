import { basename } from "node:path";
import { realpathSync } from "node:fs";
import { z } from "zod";

const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const load = z.number().nonnegative().max(1_000_000);
export const RUNNER_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/** Host sample a runner sends with its heartbeat. Every field is optional for older runners. */
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
  runnerVersion: z.string().max(32).regex(RUNNER_VERSION).optional(),
});

export type RunnerHostStatus = z.infer<typeof RunnerHostStatusSchema>;

/** The release a packaged install runs from: `<base>/releases/<version>`, or null outside a release. */
export function releaseVersion(root: string): string | null {
  try {
    const name = basename(realpathSync(root));
    return name.length <= 32 && RUNNER_VERSION.test(name) ? name : null;
  } catch {
    return null;
  }
}
