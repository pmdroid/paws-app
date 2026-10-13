import { z } from "zod";
import { RunnerCheckResultSchema } from "../runner-check";
import { RunnerEventSchema, RunnerResultSchema } from "../runner-protocol";
import { identifier } from "./state";

const generation = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const assignment = z.strictObject({ runId: identifier, generation });

export const RunnerHeartbeatSchema = z.strictObject({
  leases: z.array(z.strictObject({ ...assignment.shape, expiresAt: timestamp })),
  fenced: z.array(assignment),
});
export const RunnerGrantRequestSchema = z.strictObject({ commandId: identifier, generation });
export const RunnerGrantTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const RunnerGrantSchema = z.strictObject({
  token: RunnerGrantTokenSchema,
  expiresAt: timestamp,
});
export const RunnerEventDeliverySchema = z.strictObject({
  ...assignment.shape,
  sequence: generation,
  event: RunnerEventSchema,
});
export const RunnerEventReceiptSchema = z.strictObject({ duplicate: z.boolean() });
export const RunnerCheckDeliverySchema = z.strictObject({
  generation,
  result: RunnerCheckResultSchema,
  verifierSignature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
});
export const RunnerResultDeliverySchema = z.strictObject({
  generation,
  result: RunnerResultSchema,
});
export const RunnerAnswersRequestSchema = z.strictObject({ generation, after: timestamp });
export const RunnerAnswersSchema = z.strictObject({
  answers: z
    .array(z.strictObject({ sequence: generation, answer: z.string().min(1).max(65536) }))
    .max(64),
});
export const RunnerRepositoryAccessSchema = z.strictObject({
  generation,
  access: z.enum(["read", "write"]),
});
export const RunnerRepositoryCredentialSchema = z.strictObject({
  token: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[!-~]+$/),
  expiresAt: timestamp,
  remoteUrl: z.string().max(512),
  branch: z
    .string()
    .regex(/^paws\/[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/)
    .refine((value) => !value.includes("..") && !value.endsWith(".") && !value.endsWith(".lock"))
    .nullable(),
});

export type RunnerHeartbeat = z.infer<typeof RunnerHeartbeatSchema>;
export type RunnerGrantRequest = z.infer<typeof RunnerGrantRequestSchema>;
export type RunnerGrant = z.infer<typeof RunnerGrantSchema>;
export type RunnerEventDelivery = z.infer<typeof RunnerEventDeliverySchema>;
export type RunnerEventReceipt = z.infer<typeof RunnerEventReceiptSchema>;
export type RunnerRepositoryCredential = z.infer<typeof RunnerRepositoryCredentialSchema>;
export type RunnerAnswers = z.infer<typeof RunnerAnswersSchema>;
