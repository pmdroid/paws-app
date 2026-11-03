import { z } from "zod";
import { RUNNER_CODING_AGENTS } from "./agents";

export const RUNNER_ACCOUNT_PROTOCOL = 1;
export const LEGACY_ACCOUNT_PREFIX = "legacy_";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const named = id.refine((value) => !value.startsWith(LEGACY_ACCOUNT_PREFIX));

export const RunnerAccountSchema = z.strictObject({ accountId: named, bindingId: named });

export const RunnerAccountCapabilitySchema = z.strictObject({
  protocol: z.number().int().min(1).max(1_000),
  bindings: z
    .array(z.strictObject({ bindingId: named, agent: z.enum(RUNNER_CODING_AGENTS) }))
    .max(64)
    .refine(
      (bindings) => new Set(bindings.map((binding) => binding.bindingId)).size === bindings.length,
    ),
});

export type RunnerAccount = z.infer<typeof RunnerAccountSchema>;
export type RunnerAccountCapability = z.infer<typeof RunnerAccountCapabilitySchema>;

export function runnerAccountEchoed(
  command: { account?: RunnerAccount },
  result: { account?: RunnerAccount },
): boolean {
  if (!command.account || !result.account) return !command.account && !result.account;
  return (
    command.account.accountId === result.account.accountId &&
    command.account.bindingId === result.account.bindingId
  );
}
