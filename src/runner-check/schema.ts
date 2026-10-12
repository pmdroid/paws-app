import { z } from "zod";
import { ExecutionIdSchema } from "../runner-execution";

const text = (limit: number) =>
  z
    .string()
    .refine(
      (value) =>
        !value.includes("\0") &&
        Buffer.byteLength(value) <= limit &&
        Buffer.from(value, "utf8").toString("utf8") === value,
      "Invalid bounded text",
    );
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const RunnerCheckAttemptSchema = z.strictObject({
  format: z.literal(1),
  verificationAttemptId: ExecutionIdSchema,
  candidateSha: sha,
  bundleSha256: digest,
});
export const RunnerCheckInputSchema = z.strictObject({
  format: z.literal(1),
  executionId: ExecutionIdSchema,
  verificationAttemptId: ExecutionIdSchema,
  candidateSha: sha,
  argv: z
    .array(text(8192))
    .min(1)
    .max(128)
    .refine((value) => value[0]!.length > 0, "Empty command"),
  cwd: text(4096),
  env: z
    .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), text(8192))
    .refine((value) => Object.keys(value).length <= 128, "Too many environment values"),
  timeoutMs: z.number().int().min(1).max(900_000),
});
export const RunnerCheckRequestSchema = RunnerCheckInputSchema.omit({ format: true, env: true });
export const RunnerCheckResultSchema = z
  .strictObject({
    format: z.literal(1),
    executionId: ExecutionIdSchema,
    verificationAttemptId: ExecutionIdSchema,
    candidateSha: sha,
    inputSha256: digest,
    exitCode: z.number().int().min(0).max(255).nullable(),
    signal: z.number().int().min(1).max(64).nullable(),
    timedOut: z.boolean(),
    stdout: z.string().refine((value) => Buffer.byteLength(value) <= 1_048_576),
    stderr: z.string().refine((value) => Buffer.byteLength(value) <= 1_048_576),
    stdoutTruncated: z.boolean(),
    stderrTruncated: z.boolean(),
    durationMs: z.number().finite().nonnegative(),
    dirty: z.boolean(),
    headMoved: z.boolean(),
  })
  .refine((value) => (value.exitCode === null) !== (value.signal === null), "Invalid wait status");
export type RunnerCheckAttempt = z.infer<typeof RunnerCheckAttemptSchema>;
export type RunnerCheckInput = z.infer<typeof RunnerCheckInputSchema>;
export type RunnerCheckRequest = z.infer<typeof RunnerCheckRequestSchema>;
export type RunnerCheckResult = z.infer<typeof RunnerCheckResultSchema>;

export interface RunnerCheckPaths {
  inputRoot: string;
  workRoot: string;
  resultRoot: string;
  runnerUid: number;
  runnerGid: number;
  inputGid: number;
  checkUid: number;
  checkGid: number;
}
