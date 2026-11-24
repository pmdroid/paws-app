import { z } from "zod";

const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const id = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);

export const RunnerIssueVmDiskReportSchema = z.strictObject({
  poolBytes: bytes,
  usedBytes: bytes,
  volumes: z.array(z.strictObject({ id, sizeBytes: bytes, memoryBytes: bytes })).max(256),
  refused: z.array(id).max(256),
});

export const RunnerIssueVmDiskPlanSchema = z.strictObject({
  create: z
    .array(
      z.strictObject({
        id,
        diskGb: z.number().int().min(10).max(500),
        memoryGb: z.number().int().min(1).max(128),
      }),
    )
    .max(64),
  delete: z.array(id).max(256),
});

export type RunnerIssueVmDiskReport = z.infer<typeof RunnerIssueVmDiskReportSchema>;
export type RunnerIssueVmDiskPlan = z.infer<typeof RunnerIssueVmDiskPlanSchema>;
