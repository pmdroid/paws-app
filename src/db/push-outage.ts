import type { Database } from "bun:sqlite";
import { asc, eq, sql } from "drizzle-orm";
import { orm } from "./orm";
import { pushOutage } from "./schema";

/**
 * GitHub refuses pushes from the Paws App to a repository with no reason (PAS-867). While the row
 * exists, merge and candidate pushes to `repository` wait, and only the merge job `probeJobId`
 * pushes, at `nextProbeAt`. The first push that works deletes the row.
 */
export type PushOutage = {
  /** `owner/repo`. */
  repository: string;
  startedAt: number;
  /** GitHub's refusal, redacted. */
  lastError: string;
  lastFailedAt: number;
  /** Probe pushes that failed since the outage started. */
  failedProbes: number;
  nextProbeAt: number;
  probeJobId: number | null;
  /** The App installation's settings on GitHub, to check its permissions and repositories. */
  installationUrl: string | null;
  /** The workspace question about the outage, once Paws asked it. */
  questionId: string | null;
};

export function getPushOutage(db: Database, repository: string): PushOutage | null {
  return (
    orm(db).select().from(pushOutage).where(eq(pushOutage.repository, repository)).get() ?? null
  );
}

/** Every repository in a push outage, the oldest outage first. */
export function listPushOutages(db: Database): PushOutage[] {
  return orm(db)
    .select()
    .from(pushOutage)
    .orderBy(asc(pushOutage.startedAt), asc(pushOutage.repository))
    .all();
}

/**
 * Records a refused push. The first refusal starts the outage; a refusal of the probe counts one
 * more failed probe. `delayMs` gives the wait before the next probe for a count of failed probes.
 */
export function recordPushOutage(
  db: Database,
  input: {
    repository: string;
    error: string;
    jobId: number | null;
    installationUrl: string | null;
    now: number;
    delayMs: (failedProbes: number) => number;
  },
): PushOutage {
  const current = getPushOutage(db, input.repository);
  const failedProbes = current === null ? 0 : current.failedProbes + 1;
  orm(db)
    .insert(pushOutage)
    .values({
      repository: input.repository,
      startedAt: input.now,
      lastError: input.error,
      lastFailedAt: input.now,
      failedProbes,
      nextProbeAt: input.now + input.delayMs(failedProbes),
      probeJobId: input.jobId,
      installationUrl: input.installationUrl,
    })
    .onConflictDoUpdate({
      target: pushOutage.repository,
      set: {
        lastError: sql`excluded.last_error`,
        lastFailedAt: sql`excluded.last_failed_at`,
        failedProbes: sql`excluded.failed_probes`,
        nextProbeAt: sql`excluded.next_probe_at`,
        probeJobId: sql`excluded.probe_job_id`,
        installationUrl: sql`COALESCE(excluded.installation_url, ${pushOutage.installationUrl})`,
      },
    })
    .run();
  return getPushOutage(db, input.repository)!;
}

/** Makes `jobId` the probe of the outage, as when the probe's item stopped. */
export function takePushOutageProbe(db: Database, repository: string, jobId: number): void {
  orm(db)
    .update(pushOutage)
    .set({ probeJobId: jobId })
    .where(eq(pushOutage.repository, repository))
    .run();
}

export function setPushOutageQuestion(
  db: Database,
  repository: string,
  questionId: string | null,
): void {
  orm(db).update(pushOutage).set({ questionId }).where(eq(pushOutage.repository, repository)).run();
}

/** Ends the outage. Returns the row it removed, or null when there was none. */
export function endPushOutage(db: Database, repository: string): PushOutage | null {
  const current = getPushOutage(db, repository);
  if (current) orm(db).delete(pushOutage).where(eq(pushOutage.repository, repository)).run();
  return current;
}
