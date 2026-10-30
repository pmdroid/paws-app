import {
  CLOSEOUT_CI_KEY_RUNNER_VERSION,
  CLOSEOUT_POLICY_KEYS_RUNNER_VERSION,
  type RunnerVersion,
} from "./versions";

/**
 * The first runner release whose Closeout policy parser knows each policy key added after the
 * runners started parsing the policy, by schema path (`items[].ci`). A key not listed here is
 * known to every runner Paws places work on, or unknown to this Paws too.
 */
export const POLICY_KEY_RUNNER_VERSIONS: Readonly<Record<string, RunnerVersion>> = {
  "items[].ci": CLOSEOUT_CI_KEY_RUNNER_VERSION,
  "items[].recheck": CLOSEOUT_POLICY_KEYS_RUNNER_VERSION,
  "rules[].recheck": CLOSEOUT_POLICY_KEYS_RUNNER_VERSION,
};

/** A policy key and the first runner release that knows it. */
export type PolicyKeyNeed = { key: string; needs: string };

/** The keys a runner at `version` does not know yet, each with the release that does. */
export function policyKeysAbove(keys: readonly string[], version: string): PolicyKeyNeed[] {
  return keys.flatMap((key) => {
    const minimum = POLICY_KEY_RUNNER_VERSIONS[key];
    return minimum === undefined || runnerVersionAtLeast(version, minimum)
      ? []
      : [{ key, needs: minimum.join(".") }];
  });
}

/** Whether `version` (`major.minor.patch`, anything after it ignored) is at least `minimum`. */
export function runnerVersionAtLeast(version: string, minimum: RunnerVersion): boolean {
  const parts = version
    .match(/^(\d+)\.(\d+)\.(\d+)/)
    ?.slice(1)
    .map(Number);
  if (!parts) return false;
  for (const [index, part] of parts.entries())
    if (part !== minimum[index]) return part > minimum[index]!;
  return true;
}
