import type { Database } from "bun:sqlite";
import { policyKeys } from "../closeout";
import {
  clearPolicyRunnerWarning,
  onlineRunnerVersions,
  savePolicyRunnerWarning,
  type PolicyRunnerWarning,
} from "../db";
import { journal } from "../journal";
import { RUNNER_ONLINE_MS } from "../runner-placement";
import { policyKeysAbove, runnerVersionAtLeast } from "../runner-protocol";

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
  const lowest = lowestVersion(onlineRunnerVersions(db, input.now - RUNNER_ONLINE_MS));
  if (lowest === null) return null;
  const keys = policyKeysAbove(policyKeys(input.files), lowest);
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
    runnerVersion: lowest,
    keys,
    checkedAt: input.now,
  };
  if (savePolicyRunnerWarning(db, warning))
    journal(
      `closeout policy ${input.digest} for ${input.repository} uses ${keys
        .map((entry) => `${entry.key} (runner ${entry.needs})`)
        .join(", ")}; the lowest online runner is ${lowest} and leaves them out`,
    );
  return warning;
}

/** The lowest `major.minor.patch` release of `versions`; one that is not a release is skipped. */
function lowestVersion(versions: readonly string[]): string | null {
  let lowest: { version: string; parts: [number, number, number] } | null = null;
  for (const version of versions) {
    const parts = version
      .match(/^(\d+)\.(\d+)\.(\d+)/)
      ?.slice(1)
      .map(Number);
    if (parts === undefined) continue;
    const tuple: [number, number, number] = [parts[0]!, parts[1]!, parts[2]!];
    if (lowest === null || !runnerVersionAtLeast(version, lowest.parts))
      lowest = { version, parts: tuple };
  }
  return lowest?.version ?? null;
}
