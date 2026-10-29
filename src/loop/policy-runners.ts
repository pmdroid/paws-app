import type { Database } from "bun:sqlite";
import { policyKeys } from "../closeout";
import {
  clearPolicyRunnerWarning,
  policyKeysLowestRunnerLacks,
  savePolicyRunnerWarning,
  type PolicyRunnerWarning,
} from "../db";
import { journal } from "../journal";
import { RUNNER_OFFLINE_MS } from "./runner-wait";

/**
 * Before Paws hands a runner the repository's Closeout policy, checks its keys against the lowest
 * runner release online. A key that release does not know is recorded for the dashboard and
 * journaled once per policy digest and runner release; the runner leaves the key out and runs the
 * rest. Returns the warning, or null when every online runner knows every key or none is online.
 */
export function checkPolicyRunners(
  db: Database,
  input: {
    repository: string;
    digest: string;
    files: ReadonlyMap<string, Uint8Array>;
    now: number;
  },
): PolicyRunnerWarning | null {
  const lacks = policyKeysLowestRunnerLacks(
    db,
    policyKeys(input.files),
    input.now - RUNNER_OFFLINE_MS,
  );
  if (lacks === null) return null;
  const { runnerVersion, keys } = lacks;
  if (keys.length === 0) {
    if (clearPolicyRunnerWarning(db, input.repository))
      journal(
        `closeout policy ${input.digest} for ${input.repository}: every online runner knows its keys`,
      );
    return null;
  }
  const warning: PolicyRunnerWarning = {
    repository: input.repository,
    policyDigest: input.digest,
    runnerVersion,
    keys,
    checkedAt: input.now,
  };
  if (savePolicyRunnerWarning(db, warning))
    journal(
      `closeout policy ${input.digest} for ${input.repository} uses ${keys
        .map((entry) => `${entry.key} (runner ${entry.needs})`)
        .join(", ")}; the lowest online runner is ${runnerVersion} and leaves them out`,
    );
  return warning;
}
