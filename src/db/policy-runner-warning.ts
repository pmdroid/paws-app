import type { Database } from "bun:sqlite";
import { and, eq, gt, isNotNull, isNull, ne } from "drizzle-orm";
import { policyKeysAbove, runnerVersionAtLeast, type PolicyKeyNeed } from "../runner-protocol";
import { changes, orm } from "./orm";
import { policyRunnerWarning, runner, runnerHostStatus } from "./schema";

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

const map = (row: typeof policyRunnerWarning.$inferSelect): PolicyRunnerWarning => ({
  ...row,
  keys: JSON.parse(row.keys) as PolicyRunnerWarning["keys"],
});

/**
 * Records the warning for its repository, replacing the one before. True when the digest, the
 * runner version or the keys differ from the recorded warning, so the caller reports it once.
 */
export function savePolicyRunnerWarning(db: Database, warning: PolicyRunnerWarning): boolean {
  const keys = JSON.stringify(warning.keys);
  const before = orm(db)
    .select()
    .from(policyRunnerWarning)
    .where(eq(policyRunnerWarning.repository, warning.repository))
    .get();
  const values = {
    policyDigest: warning.policyDigest,
    runnerVersion: warning.runnerVersion,
    keys,
    checkedAt: warning.checkedAt,
  };
  orm(db)
    .insert(policyRunnerWarning)
    .values({ repository: warning.repository, ...values })
    .onConflictDoUpdate({ target: policyRunnerWarning.repository, set: values })
    .run();
  return (
    before === undefined ||
    before.policyDigest !== warning.policyDigest ||
    before.runnerVersion !== warning.runnerVersion ||
    before.keys !== keys
  );
}

/** Every runner can apply the repository's policy. True when a warning was recorded before. */
export function clearPolicyRunnerWarning(db: Database, repository: string): boolean {
  return (
    changes(
      orm(db).delete(policyRunnerWarning).where(eq(policyRunnerWarning.repository, repository)),
    ) > 0
  );
}

export function listPolicyRunnerWarnings(db: Database): PolicyRunnerWarning[] {
  return orm(db)
    .select()
    .from(policyRunnerWarning)
    .orderBy(policyRunnerWarning.repository)
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
  return orm(db)
    .select({ version: runnerHostStatus.runnerVersion })
    .from(runner)
    .innerJoin(runnerHostStatus, eq(runnerHostStatus.runnerId, runner.id))
    .where(
      and(
        ne(runner.status, "revoked"),
        isNull(runner.revokedAt),
        gt(runner.lastSeenAt, onlineSince),
        isNotNull(runnerHostStatus.runnerVersion),
      ),
    )
    .all()
    .map((row) => row.version!);
}
