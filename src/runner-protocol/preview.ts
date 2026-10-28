import { z } from "zod";

export const PreviewRequestSchema = z.strictObject({
  command: z.array(z.string().min(1).max(4096)).min(1).max(32),
  port: z.number().int().min(1024).max(65535),
  startPath: z
    .string()
    .max(2048)
    .default("/")
    .refine(
      (value) => value.startsWith("/") && !value.startsWith("//") && !/[\\\r\n\0]/.test(value),
    ),
  checklist: z.array(z.string().trim().min(1).max(500)).min(1).max(12),
  checkId: z
    .string()
    .regex(/^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*$/)
    .default("live-preview"),
});
export type PreviewRequest = z.infer<typeof PreviewRequestSchema>;
export const PreviewReadySchema = z.strictObject({
  ...PreviewRequestSchema.shape,
  id: z.string().uuid(),
  head: z.string().regex(/^[a-f0-9]{40}$/),
  url: z
    .string()
    .url()
    .refine((value) => /^https:\/\/paws-preview-[1-9][0-9]*\.[a-z0-9-]+\.ts\.net\//.test(value)),
  expiresAt: z.number().int().positive(),
  frameable: z.boolean(),
});
export type PreviewReady = z.infer<typeof PreviewReadySchema>;
