import type { Database } from "bun:sqlite";
import { policyKeysAbove, runnerVersionAtLeast, type PolicyKeyNeed } from "../runner-protocol";

/**
 * A repository's Closeout policy uses keys the lowest online runner is too old to know. That
 * runner leaves them out of the policy it applies, so the checks run without them.
 */
export type PolicyRunnerWarning = {
  /** `owner/repo`. */
  repository: string;
  policyDigest: string;
  /** The lowest runner release online when Paws checked. */
  runnerVersion: string;
  /** Each key that runner does not know, with the first release that does. */
  keys: PolicyKeyNeed[];
  checkedAt: number;
};

type Row = {
  repository: string;
  policy_digest: string;
  runner_version: string;
  keys: string;
  checked_at: number;
};

const map = (row: Row): PolicyRunnerWarning => ({
  repository: row.repository,
  policyDigest: row.policy_digest,
  runnerVersion: row.runner_version,
  keys: JSON.parse(row.keys) as PolicyRunnerWarning["keys"],
  checkedAt: row.checked_at,
});

/**
 * Records the warning for its repository, replacing the one before. True when the digest, the
 * runner version or the keys differ from the recorded warning, so the caller reports it once.
 */
export function savePolicyRunnerWarning(db: Database, warning: PolicyRunnerWarning): boolean {
  const keys = JSON.stringify(warning.keys);
  const before = db
    .query<Row, [string]>("SELECT * FROM policy_runner_warning WHERE repository = ?")
    .get(warning.repository);
  db.run(
    `INSERT INTO policy_runner_warning (repository, policy_digest, runner_version, keys, checked_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(repository) DO UPDATE SET
       policy_digest = excluded.policy_digest,
       runner_version = excluded.runner_version,
       keys = excluded.keys,
       checked_at = excluded.checked_at`,
    [warning.repository, warning.policyDigest, warning.runnerVersion, keys, warning.checkedAt],
  );
  return (
    before === null ||
    before.policy_digest !== warning.policyDigest ||
    before.runner_version !== warning.runnerVersion ||
    before.keys !== keys
  );
}

/** Every runner can apply the repository's policy. True when a warning was recorded before. */
export function clearPolicyRunnerWarning(db: Database, repository: string): boolean {
  return db.run("DELETE FROM policy_runner_warning WHERE repository = ?", [repository]).changes > 0;
}

export function listPolicyRunnerWarnings(db: Database): PolicyRunnerWarning[] {
  return db
    .query<Row, []>("SELECT * FROM policy_runner_warning ORDER BY repository")
    .all()
    .map(map);
}

/**
 * The lowest release among runners online since `onlineSince`, with the policy `keys` it does not
 * know and the first release that does. Null when no online runner reported a release.
 */
export function policyKeysLowestRunnerLacks(
  db: Database,
  keys: readonly string[],
  onlineSince: number,
): { runnerVersion: string; keys: PolicyKeyNeed[] } | null {
  const lowest = lowestVersion(onlineRunnerVersions(db, onlineSince));
  return lowest === null ? null : { runnerVersion: lowest, keys: policyKeysAbove(keys, lowest) };
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

/**
 * The release of each runner not revoked and seen since `onlineSince` that reported one. A runner
 * that has not reported its release is left out.
 */
function onlineRunnerVersions(db: Database, onlineSince: number): string[] {
  return db
    .query<{ version: string }, [number]>(
      `SELECT h.runner_version AS version FROM runner r
       JOIN runner_host_status h ON h.runner_id = r.id
       WHERE r.status <> 'revoked' AND r.revoked_at IS NULL AND r.last_seen_at > ?
         AND h.runner_version IS NOT NULL`,
    )
    .all(onlineSince)
    .map((row) => row.version);
}
