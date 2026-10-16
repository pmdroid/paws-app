import { z } from "zod";

const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const load = z.number().nonnegative().max(1_000_000);

export const RUNNER_VERSION_PATTERN =
  /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;

/** Latest host sample a runner reports with its heartbeat. Every field is optional. */
export const RunnerHostStatusSchema = z.strictObject({
  cpuPercent: z.number().min(0).max(100).optional(),
  memoryTotalBytes: bytes.optional(),
  memoryAvailableBytes: bytes.optional(),
  load1: load.optional(),
  load5: load.optional(),
  load15: load.optional(),
  diskFreeBytes: bytes.optional(),
  diskTotalBytes: bytes.optional(),
  osId: z
    .string()
    .regex(/^[a-z0-9._-]{1,64}$/)
    .optional(),
  osVersion: z
    .string()
    .regex(/^[A-Za-z0-9._~+-]{1,64}$/)
    .optional(),
  runnerVersion: z.string().regex(RUNNER_VERSION_PATTERN).optional(),
});

export type RunnerHostStatus = z.infer<typeof RunnerHostStatusSchema>;
