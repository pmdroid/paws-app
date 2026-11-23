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

export const STORAGE_CLEANUP_ITEM_LIMIT = 10_000;
const cleanupId = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
const ref = z.string().min(1).max(128);
const reason = z.string().min(1).max(256);

export const RunnerStorageCleanupFields = {
  cleanupId,
  mode: z.enum(["preview", "run"]),
  category: z.literal("worker_logs"),
  olderThanDays: z.number().int().min(1).max(3650),
  items: z.array(ref).max(STORAGE_CLEANUP_ITEM_LIMIT).optional(),
};

const items = z.array(z.strictObject({ ref, bytes: count })).max(STORAGE_CLEANUP_ITEM_LIMIT);

export const RunnerStorageCleanupResultSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    cleanupId,
    mode: z.literal("preview"),
    items,
    kept: z.array(z.strictObject({ reason, count })).max(64),
  }),
  z.strictObject({
    cleanupId,
    mode: z.literal("run"),
    deleted: items,
    skipped: z.array(z.strictObject({ ref, reason })).max(STORAGE_CLEANUP_ITEM_LIMIT),
    freedBytes: count,
  }),
]);

export type RunnerStorageCleanupResult = z.infer<typeof RunnerStorageCleanupResultSchema>;
