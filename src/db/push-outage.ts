import type { Database } from "bun:sqlite";
import { and, asc, eq, sql } from "drizzle-orm";
import { JOB_KIND } from "../core";
import { settled, sqliteDb, type Q, type Steps } from "./db";
import { jsonField } from "./json-text";
import { least } from "./pull-comments";

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

export function* getPushOutageSteps(q: Q, repository: string): Steps<PushOutage | null> {
  const { pushOutage } = q.t;
  return (
    (yield* q.one(q.orm.select().from(pushOutage).where(eq(pushOutage.repository, repository)))) ??
    null
  );
}

export function getPushOutage(db: Database, repository: string): PushOutage | null {
  return settled(sqliteDb(db).run((q) => getPushOutageSteps(q, repository)));
}

export function* listPushOutagesSteps(q: Q): Steps<PushOutage[]> {
  const { pushOutage } = q.t;
  return yield* q.all(
    q.orm.select().from(pushOutage).orderBy(asc(pushOutage.startedAt), asc(pushOutage.repository)),
  );
}

/** Every repository in a push outage, the oldest outage first. */
export function listPushOutages(db: Database): PushOutage[] {
  return settled(sqliteDb(db).run(listPushOutagesSteps));
}

type PushOutageRefusal = {
  repository: string;
  error: string;
  jobId: number | null;
  installationUrl: string | null;
  now: number;
  delayMs: (failedProbes: number) => number;
};

export function* recordPushOutageSteps(q: Q, input: PushOutageRefusal): Steps<PushOutage> {
  const { pushOutage } = q.t;
  const current = yield* getPushOutageSteps(q, input.repository);
  const failedProbes = current === null ? 0 : current.failedProbes + 1;
  yield* q.exec(
    q.orm
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
      }),
  );
  return (yield* getPushOutageSteps(q, input.repository))!;
}

/**
 * Records a refused push. The first refusal starts the outage; a refusal of the probe counts one
 * more failed probe. `delayMs` gives the wait before the next probe for a count of failed probes.
 */
export function recordPushOutage(db: Database, input: PushOutageRefusal): PushOutage {
  return settled(sqliteDb(db).run((q) => recordPushOutageSteps(q, input)));
}

export function* takePushOutageProbeSteps(q: Q, repository: string, jobId: number) {
  const { pushOutage } = q.t;
  yield* q.exec(
    q.orm
      .update(pushOutage)
      .set({ probeJobId: jobId })
      .where(eq(pushOutage.repository, repository)),
  );
}

/** Makes `jobId` the probe of the outage, as when the probe's item stopped. */
export function takePushOutageProbe(db: Database, repository: string, jobId: number): void {
  settled(sqliteDb(db).run((q) => takePushOutageProbeSteps(q, repository, jobId)));
}

export function* setPushOutageQuestionSteps(q: Q, repository: string, questionId: string | null) {
  const { pushOutage } = q.t;
  yield* q.exec(
    q.orm.update(pushOutage).set({ questionId }).where(eq(pushOutage.repository, repository)),
  );
}

export function setPushOutageQuestion(
  db: Database,
  repository: string,
  questionId: string | null,
): void {
  settled(sqliteDb(db).run((q) => setPushOutageQuestionSteps(q, repository, questionId)));
}

export function* endPushOutageSteps(q: Q, repository: string): Steps<PushOutage | null> {
  const { pushOutage } = q.t;
  const current = yield* getPushOutageSteps(q, repository);
  if (current) yield* q.exec(q.orm.delete(pushOutage).where(eq(pushOutage.repository, repository)));
  return current;
}

/** Ends the outage. Returns the row it removed, or null when there was none. */
export function endPushOutage(db: Database, repository: string): PushOutage | null {
  return settled(sqliteDb(db).run((q) => endPushOutageSteps(q, repository)));
}

/** Merge jobs parked on the outage run by `now`, when the outage ends. */
export function* releasePushOutageJobsSteps(q: Q, repository: string, now: number): Steps<void> {
  const { job } = q.t;
  yield* q.exec(
    q.orm
      .update(job)
      .set({ runAt: least(q, sql`${job.runAt}`, sql`${now}`) })
      .where(
        and(
          eq(job.queue, JOB_KIND.merge),
          eq(job.status, "pending"),
          eq(jsonField(q, job.payload, "pushOutage"), repository),
        ),
      ),
  );
}

export function releasePushOutageJobs(db: Database, repository: string, now: number): void {
  settled(sqliteDb(db).run((q) => releasePushOutageJobsSteps(q, repository, now)));
}
