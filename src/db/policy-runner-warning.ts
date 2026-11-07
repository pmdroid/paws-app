import type { Database } from "bun:sqlite";
import { and, eq, gt, isNotNull, isNull, ne } from "drizzle-orm";
import { policyKeysAbove, runnerVersionAtLeast, type PolicyKeyNeed } from "../runner-protocol";
import { settled, sqliteDb, type Q, type Steps } from "./db";
import type * as pg from "./schema-pg";

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

const map = (row: typeof pg.policyRunnerWarning.$inferSelect): PolicyRunnerWarning => ({
  ...row,
  keys: JSON.parse(row.keys) as PolicyRunnerWarning["keys"],
});

export function* savePolicyRunnerWarningSteps(q: Q, warning: PolicyRunnerWarning) {
  const { policyRunnerWarning } = q.t;
  const keys = JSON.stringify(warning.keys);
  const before = yield* q.one(
    q.orm
      .select()
      .from(policyRunnerWarning)
      .where(eq(policyRunnerWarning.repository, warning.repository)),
  );
  const values = {
    policyDigest: warning.policyDigest,
    runnerVersion: warning.runnerVersion,
    keys,
    checkedAt: warning.checkedAt,
  };
  yield* q.exec(
    q.orm
      .insert(policyRunnerWarning)
      .values({ repository: warning.repository, ...values })
      .onConflictDoUpdate({ target: policyRunnerWarning.repository, set: values }),
  );
  return (
    before === undefined ||
    before.policyDigest !== warning.policyDigest ||
    before.runnerVersion !== warning.runnerVersion ||
    before.keys !== keys
  );
}

/**
 * Records the warning for its repository, replacing the one before. True when the digest, the
 * runner version or the keys differ from the recorded warning, so the caller reports it once.
 */
export function savePolicyRunnerWarning(db: Database, warning: PolicyRunnerWarning): boolean {
  return settled(sqliteDb(db).run((q) => savePolicyRunnerWarningSteps(q, warning)));
}

export function* clearPolicyRunnerWarningSteps(q: Q, repository: string) {
  const { policyRunnerWarning } = q.t;
  const removed = yield* q.all(
    q.orm
      .delete(policyRunnerWarning)
      .where(eq(policyRunnerWarning.repository, repository))
      .returning({ repository: policyRunnerWarning.repository }),
  );
  return removed.length > 0;
}

/** Every runner can apply the repository's policy. True when a warning was recorded before. */
export function clearPolicyRunnerWarning(db: Database, repository: string): boolean {
  return settled(sqliteDb(db).run((q) => clearPolicyRunnerWarningSteps(q, repository)));
}

export function* listPolicyRunnerWarningsSteps(q: Q): Steps<PolicyRunnerWarning[]> {
  const { policyRunnerWarning } = q.t;
  const rows = yield* q.all(
    q.orm.select().from(policyRunnerWarning).orderBy(policyRunnerWarning.repository),
  );
  return rows.map(map);
}

export function listPolicyRunnerWarnings(db: Database): PolicyRunnerWarning[] {
  return settled(sqliteDb(db).run(listPolicyRunnerWarningsSteps));
}

/**
 * The lowest release among runners online since `onlineSince`, with the policy `keys` it does not
 * know and the first release that does. Null when no online runner reported a release.
 */
export function* policyKeysLowestRunnerLacksSteps(
  q: Q,
  keys: readonly string[],
  onlineSince: number,
): Steps<{ runnerVersion: string; keys: PolicyKeyNeed[] } | null> {
  const lowest = lowestVersion(yield* onlineRunnerVersionsSteps(q, onlineSince));
  return lowest === null ? null : { runnerVersion: lowest, keys: policyKeysAbove(keys, lowest) };
}

export function policyKeysLowestRunnerLacks(
  db: Database,
  keys: readonly string[],
  onlineSince: number,
): { runnerVersion: string; keys: PolicyKeyNeed[] } | null {
  return settled(sqliteDb(db).run((q) => policyKeysLowestRunnerLacksSteps(q, keys, onlineSince)));
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
function* onlineRunnerVersionsSteps(q: Q, onlineSince: number) {
  const { runner, runnerHostStatus } = q.t;
  const rows = yield* q.all(
    q.orm
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
      ),
  );
  return rows.map((row) => row.version!);
}
