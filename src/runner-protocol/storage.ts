import { z } from "zod";

export const RUNNER_STORAGE_CATEGORIES = [
  "repositories",
  "worker_logs",
  "executions",
  "health",
  "tool_caches",
  "other",
] as const;

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const filesystem = z.strictObject({
  mount: z.string().min(1).max(4096),
  type: z.string().min(1).max(64),
  totalBytes: count,
  freeBytes: count,
  inodesTotal: count.optional(),
  inodesFree: count.optional(),
  memory: z.literal(true).optional(),
});

export const RunnerStorageReportSchema = z.strictObject({
  commandId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
  takenAt: count,
  partial: z.boolean(),
  filesystems: z.strictObject({ home: filesystem.nullable(), tmp: filesystem.nullable() }),
  categories: z.partialRecord(
    z.enum(RUNNER_STORAGE_CATEGORIES),
    z.strictObject({ bytes: count, files: count }),
  ),
});

export type RunnerStorageReport = z.infer<typeof RunnerStorageReportSchema>;
