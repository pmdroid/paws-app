import { z } from "zod";

export const RUNNER_PROBE_DIRECTORY = ".agents/probes";
export const RUNNER_PROBE_BYTES = 49_152;

export const RunnerProbePathSchema = z
  .string()
  .max(128)
  .regex(/^\.agents\/probes\/[a-z][a-z0-9]*(-[a-z0-9]+)*\.ts$/);

export const RunnerProbeEntrySchema = z.object({
  exec: z.array(z.string().min(1).max(4096)).min(1).max(32).optional(),
  paths: z.array(z.string().min(1).max(256)).min(1).max(100).optional(),
  failOn: z.enum(["P0", "P1", "P2", "P3"]),
  onFail: z.enum(["fix", "approve"]).optional(),
});

export const RunnerProbeResultSchema = z.strictObject({
  path: RunnerProbePathSchema,
  content: z
    .string()
    .min(1)
    .max(Math.ceil(RUNNER_PROBE_BYTES / 3) * 4)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  entry: RunnerProbeEntrySchema.strict(),
});

export type RunnerProbeEntry = z.infer<typeof RunnerProbeEntrySchema>;
export type RunnerProbeResult = z.infer<typeof RunnerProbeResultSchema>;
