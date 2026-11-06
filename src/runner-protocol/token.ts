import { z } from "zod";

export const RUNNER_TOKEN_MAX_LENGTH = 4096;

export const RunnerTokenSchema = z
  .string()
  .min(1)
  .max(RUNNER_TOKEN_MAX_LENGTH)
  .regex(/^[!-~]+$/);

export function isRunnerToken(value: unknown): value is string {
  return RunnerTokenSchema.safeParse(value).success;
}
