import type { Database } from "bun:sqlite";

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

type Row = {
  repository: string;
  started_at: number;
  last_error: string;
  last_failed_at: number;
  failed_probes: number;
  next_probe_at: number;
  probe_job_id: number | null;
  installation_url: string | null;
  question_id: string | null;
};

const map = (row: Row): PushOutage => ({
  repository: row.repository,
  startedAt: row.started_at,
  lastError: row.last_error,
  lastFailedAt: row.last_failed_at,
  failedProbes: row.failed_probes,
  nextProbeAt: row.next_probe_at,
  probeJobId: row.probe_job_id,
  installationUrl: row.installation_url,
  questionId: row.question_id,
});

export function getPushOutage(db: Database, repository: string): PushOutage | null {
  const row = db
    .query<Row, [string]>("SELECT * FROM push_outage WHERE repository = ?")
    .get(repository);
  return row ? map(row) : null;
}

/** Every repository in a push outage, the oldest outage first. */
export function listPushOutages(db: Database): PushOutage[] {
  return db
    .query<Row, []>("SELECT * FROM push_outage ORDER BY started_at, repository")
    .all()
    .map(map);
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
  db.run(
    `INSERT INTO push_outage
       (repository, started_at, last_error, last_failed_at, failed_probes, next_probe_at,
        probe_job_id, installation_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (repository) DO UPDATE SET
       last_error = excluded.last_error, last_failed_at = excluded.last_failed_at,
       failed_probes = excluded.failed_probes, next_probe_at = excluded.next_probe_at,
       probe_job_id = excluded.probe_job_id,
       installation_url = COALESCE(excluded.installation_url, installation_url)`,
    [
      input.repository,
      input.now,
      input.error,
      input.now,
      failedProbes,
      input.now + input.delayMs(failedProbes),
      input.jobId,
      input.installationUrl,
    ],
  );
  return getPushOutage(db, input.repository)!;
}

/** Makes `jobId` the probe of the outage, as when the probe's item stopped. */
export function takePushOutageProbe(db: Database, repository: string, jobId: number): void {
  db.run("UPDATE push_outage SET probe_job_id = ? WHERE repository = ?", [jobId, repository]);
}

export function setPushOutageQuestion(
  db: Database,
  repository: string,
  questionId: string | null,
): void {
  db.run("UPDATE push_outage SET question_id = ? WHERE repository = ?", [questionId, repository]);
}

/** Ends the outage. Returns the row it removed, or null when there was none. */
export function endPushOutage(db: Database, repository: string): PushOutage | null {
  const current = getPushOutage(db, repository);
  if (current) db.run("DELETE FROM push_outage WHERE repository = ?", [repository]);
  return current;
}
