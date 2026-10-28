import type { Database } from "bun:sqlite";
import { immediate } from "./tx";

export const CLOSEOUT_OUTPUT_CAP_BYTES = 64 * 1024;

export type CloseoutProgressIdentity = {
  taskId: string;
  base: string;
  head: string;
  policyDigest: string;
  policyPath: string | null;
};

export type CloseoutStepWrite = {
  id: string;
  kind: "setup" | "command" | "review";
  state: "pending" | "running" | "passed" | "failed" | "blocked" | "skipped" | "exhausted";
  command: string;
  detail: string | null;
  attempt: number;
  timeoutSeconds: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  exitCode: number | null;
  timedOut: boolean;
  timeoutReason: string | null;
  truncated: boolean;
  logPath: string | null;
  evidencePath: string | null;
  findings: string | null;
  ordinal: number;
  durationMs?: number | null;
  tokens?: number | null;
  /** A review's `failOn`. */
  failOn?: "P0" | "P1" | "P2" | "P3" | null;
  /** Indexes of the review record's findings that are in pre-existing code. */
  preExisting?: readonly number[] | null;
};

export type CloseoutStepRecord = CloseoutStepWrite & {
  stdout: string;
  stderr: string;
};

export type CloseoutProgressRecord = CloseoutProgressIdentity & {
  id: string;
  itemId: string;
  decision: string | null;
  startedAt: number;
  updatedAt: number;
  finishedAt: number | null;
  steps: CloseoutStepRecord[];
};

type ProgressSql = {
  id: string;
  item_id: string;
  task_id: string;
  base: string;
  head: string;
  policy_digest: string;
  policy_path: string | null;
  decision: string | null;
  started_at: number;
  updated_at: number;
  finished_at: number | null;
};

type StepSql = {
  progress_id: string;
  step_id: string;
  kind: CloseoutStepWrite["kind"];
  state: CloseoutStepWrite["state"];
  command: string;
  detail: string | null;
  attempt: number;
  timeout_seconds: number | null;
  started_at: number | null;
  finished_at: number | null;
  exit_code: number | null;
  timed_out: number;
  timeout_reason: string | null;
  stdout: string;
  stderr: string;
  truncated: number;
  log_path: string | null;
  evidence_path: string | null;
  findings: string | null;
  ordinal: number;
  duration_ms: number | null;
  tokens: number | null;
  review_fail_on: "P0" | "P1" | "P2" | "P3" | null;
  review_pre_existing: string | null;
};

export function ensureCloseoutProgress(
  db: Database,
  itemId: string,
  identity: CloseoutProgressIdentity,
  now: number,
  reset: boolean,
): string {
  const id = progressKey(itemId, identity);
  immediate(db, () => {
    db.run(
      `INSERT INTO closeout_progress (
         id, item_id, task_id, base, head, policy_digest, policy_path, decision, started_at, updated_at, finished_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET
         updated_at = excluded.updated_at,
         base = excluded.base,
         policy_path = COALESCE(excluded.policy_path, closeout_progress.policy_path),
         decision = CASE WHEN ? = 1 THEN NULL ELSE closeout_progress.decision END,
         finished_at = CASE WHEN ? = 1 THEN NULL ELSE closeout_progress.finished_at END`,
      [
        id,
        itemId,
        identity.taskId,
        identity.base,
        identity.head,
        identity.policyDigest,
        identity.policyPath,
        now,
        now,
        reset ? 1 : 0,
        reset ? 1 : 0,
      ],
    );
  });
  return id;
}

export function upsertCloseoutStep(
  db: Database,
  itemId: string,
  identity: CloseoutProgressIdentity,
  step: CloseoutStepWrite,
  now: number,
): void {
  const progressId = ensureCloseoutProgress(db, itemId, identity, now, false);
  const existing = db
    .query<
      Pick<
        StepSql,
        | "command"
        | "ordinal"
        | "attempt"
        | "state"
        | "started_at"
        | "findings"
        | "truncated"
        | "duration_ms"
        | "tokens"
        | "review_fail_on"
        | "review_pre_existing"
      >,
      [string, string]
    >(
      `SELECT command, ordinal, attempt, state, started_at, findings, truncated, duration_ms, tokens,
              review_fail_on, review_pre_existing
       FROM closeout_step WHERE progress_id = ? AND step_id = ?`,
    )
    .get(progressId, step.id);
  const clearOutput =
    existing !== null &&
    (step.state === "pending" || (step.state === "running" && existing.state !== "running"));
  const command = step.command.length > 0 ? step.command : (existing?.command ?? step.id);
  const ordinal = step.ordinal >= 0 ? step.ordinal : (existing?.ordinal ?? 0);
  const startedAt = startedAtFor(existing, step);
  const attempt = step.attempt > 0 ? step.attempt : (existing?.attempt ?? step.attempt);
  const findings = findingsFor(existing, step);
  const rerun = step.state === "running" || step.state === "pending";
  const durationMs = step.durationMs ?? (rerun ? null : (existing?.duration_ms ?? null));
  const tokens = step.tokens ?? (rerun ? null : (existing?.tokens ?? null));
  const truncated = clearOutput ? step.truncated : step.truncated || existing?.truncated === 1;
  // A review keeps its marks until a new review of the step reports them again.
  const failOn = step.failOn ?? (rerun ? null : (existing?.review_fail_on ?? null));
  const preExisting =
    step.preExisting != null
      ? JSON.stringify(step.preExisting)
      : rerun
        ? null
        : (existing?.review_pre_existing ?? null);
  immediate(db, () => {
    db.run(
      `INSERT INTO closeout_step (
         progress_id, step_id, kind, state, command, detail, attempt, timeout_seconds,
         started_at, finished_at, exit_code, timed_out, timeout_reason, stdout, stderr,
         truncated, log_path, evidence_path, findings, ordinal, duration_ms, tokens,
         review_fail_on, review_pre_existing
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(progress_id, step_id) DO UPDATE SET
         kind = excluded.kind,
         state = excluded.state,
         command = excluded.command,
         detail = excluded.detail,
         attempt = excluded.attempt,
         timeout_seconds = excluded.timeout_seconds,
         started_at = excluded.started_at,
         finished_at = excluded.finished_at,
         exit_code = excluded.exit_code,
         timed_out = excluded.timed_out,
         timeout_reason = excluded.timeout_reason,
         truncated = excluded.truncated,
         log_path = excluded.log_path,
         evidence_path = excluded.evidence_path,
         findings = excluded.findings,
         ordinal = excluded.ordinal,
         duration_ms = excluded.duration_ms,
         tokens = excluded.tokens,
         review_fail_on = excluded.review_fail_on,
         review_pre_existing = excluded.review_pre_existing`,
      [
        progressId,
        step.id,
        step.kind,
        step.state,
        command,
        step.detail,
        attempt,
        step.timeoutSeconds,
        startedAt,
        step.finishedAt,
        step.exitCode,
        step.timedOut ? 1 : 0,
        step.timeoutReason,
        truncated ? 1 : 0,
        step.logPath,
        step.evidencePath,
        findings,
        ordinal,
        durationMs,
        tokens,
        failOn,
        preExisting,
      ],
    );
    if (clearOutput) {
      db.run(
        "UPDATE closeout_step SET stdout = '', stderr = '' WHERE progress_id = ? AND step_id = ?",
        [progressId, step.id],
      );
    }
  });
}

function startedAtFor(
  existing: Pick<StepSql, "state" | "started_at"> | null,
  step: CloseoutStepWrite,
): number | null {
  if (step.state === "pending") return null;
  if (existing?.state === "running") return existing.started_at ?? step.startedAt;
  if (step.state === "running") return step.startedAt;
  return step.startedAt ?? existing?.started_at ?? null;
}

function findingsFor(
  existing: Pick<StepSql, "state" | "findings"> | null,
  step: CloseoutStepWrite,
): string | null {
  if (step.findings !== null) return step.findings;
  if (step.state === "running" && existing?.state !== "running") return null;
  return existing?.findings ?? null;
}

export function appendCloseoutOutput(
  db: Database,
  itemId: string,
  identity: CloseoutProgressIdentity,
  stepId: string,
  stream: "stdout" | "stderr",
  text: string,
  truncated: boolean,
  now: number,
): void {
  const progressId = progressKey(itemId, identity);
  const column = stream === "stderr" ? "stderr" : "stdout";
  immediate(db, () => {
    const row = db
      .query<{ stdout: string; stderr: string }, [string, string]>(
        "SELECT stdout, stderr FROM closeout_step WHERE progress_id = ? AND step_id = ?",
      )
      .get(progressId, stepId);
    if (row === null) return;
    const current = column === "stderr" ? row.stderr : row.stdout;
    const appended = bound(current, text);
    db.run(
      `UPDATE closeout_step
       SET ${column} = ?, truncated = MAX(truncated, ?)
       WHERE progress_id = ? AND step_id = ?`,
      [appended.text, appended.truncated || truncated ? 1 : 0, progressId, stepId],
    );
    db.run("UPDATE closeout_progress SET updated_at = ? WHERE id = ?", [now, progressId]);
  });
}

export function finishCloseoutProgress(
  db: Database,
  itemId: string,
  identity: CloseoutProgressIdentity,
  decision: string,
  now: number,
): void {
  const id = ensureCloseoutProgress(db, itemId, identity, now, false);
  db.run(
    "UPDATE closeout_progress SET decision = ?, finished_at = ?, updated_at = ? WHERE id = ?",
    [decision, now, now, id],
  );
}

export function latestCloseoutIdentity(
  db: Database,
  itemId: string,
): { head: string; policyDigest: string } | null {
  return db
    .query<{ head: string; policyDigest: string }, [string]>(
      `SELECT head, policy_digest AS policyDigest FROM closeout_progress
       WHERE item_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1`,
    )
    .get(itemId);
}

/** The policy digest of the latest Closeout run on `head`, or null when none was recorded. */
export function closeoutPolicyDigest(db: Database, itemId: string, head: string): string | null {
  return (
    db
      .query<{ policyDigest: string }, [string, string]>(
        `SELECT policy_digest AS policyDigest FROM closeout_progress
         WHERE item_id = ? AND head = ? ORDER BY updated_at DESC, id DESC LIMIT 1`,
      )
      .get(itemId, head)?.policyDigest ?? null
  );
}

/** The review steps of an accepted Closeout run, with the marks Closeout gave their findings. */
export type AcceptedCloseoutReviews = {
  taskId: string;
  head: string;
  reviews: Array<Pick<CloseoutStepRecord, "id" | "attempt" | "failOn" | "preExisting">>;
};

/**
 * The latest accepted Closeout run of the item: the one on `head` when there is one, otherwise
 * the last accepted head, as a head rebased after acceptance carries it.
 */
export function acceptedCloseoutReviews(
  db: Database,
  itemId: string,
  head: string | null,
): AcceptedCloseoutReviews | null {
  const run = db
    .query<{ id: string; taskId: string; head: string }, [string, string | null]>(
      `SELECT id, task_id AS taskId, head FROM closeout_progress
       WHERE item_id = ?1 AND decision = 'accepted'
       ORDER BY head = ?2 DESC, updated_at DESC, id DESC LIMIT 1`,
    )
    .get(itemId, head);
  if (run === null) return null;
  return { taskId: run.taskId, head: run.head, reviews: reviewSteps(db, run.id) };
}

/** An accepted Closeout run with its review steps and when Closeout finished it. */
export type AcceptedCloseoutRun = AcceptedCloseoutReviews & { itemId: string; at: number };

/** Every accepted Closeout run, oldest first. */
export function acceptedCloseoutRuns(db: Database): AcceptedCloseoutRun[] {
  return db
    .query<{ id: string; itemId: string; taskId: string; head: string; at: number }, []>(
      `SELECT id, item_id AS itemId, task_id AS taskId, head,
         COALESCE(finished_at, updated_at) AS at
       FROM closeout_progress WHERE decision = 'accepted' ORDER BY at, id`,
    )
    .all()
    .map((run) => ({
      itemId: run.itemId,
      taskId: run.taskId,
      head: run.head,
      at: run.at,
      reviews: reviewSteps(db, run.id),
    }));
}

function reviewSteps(db: Database, progressId: string): AcceptedCloseoutReviews["reviews"] {
  return db
    .query<
      Pick<StepSql, "step_id" | "attempt" | "review_fail_on" | "review_pre_existing">,
      [string]
    >(
      `SELECT step_id, attempt, review_fail_on, review_pre_existing FROM closeout_step
       WHERE progress_id = ? AND kind = 'review' ORDER BY ordinal, step_id`,
    )
    .all(progressId)
    .map((step) => ({
      id: step.step_id,
      attempt: step.attempt,
      failOn: step.review_fail_on,
      preExisting: indexes(step.review_pre_existing),
    }));
}

/** When Closeout first evaluated each head of the item, by head. */
export function closeoutHeadsStarted(db: Database, itemId: string): Map<string, number> {
  const rows = db
    .query<{ head: string; startedAt: number }, [string]>(
      `SELECT head, MIN(started_at) AS startedAt FROM closeout_progress
       WHERE item_id = ? GROUP BY head`,
    )
    .all(itemId);
  return new Map(rows.map((row) => [row.head, row.startedAt]));
}

export function listCloseoutProgress(db: Database): CloseoutProgressRecord[] {
  const runs = db
    .query<ProgressSql, []>("SELECT * FROM closeout_progress ORDER BY updated_at, id")
    .all();
  const steps = db
    .query<StepSql, []>("SELECT * FROM closeout_step ORDER BY ordinal, step_id")
    .all();
  return runs.map((run) => ({
    id: run.id,
    itemId: run.item_id,
    taskId: run.task_id,
    base: run.base,
    head: run.head,
    policyDigest: run.policy_digest,
    policyPath: run.policy_path,
    decision: run.decision,
    startedAt: run.started_at,
    updatedAt: run.updated_at,
    finishedAt: run.finished_at,
    steps: steps.filter((step) => step.progress_id === run.id).map(mapStep),
  }));
}

function mapStep(row: StepSql): CloseoutStepRecord {
  return {
    id: row.step_id,
    kind: row.kind,
    state: row.state,
    command: row.command,
    detail: row.detail,
    attempt: row.attempt,
    timeoutSeconds: row.timeout_seconds,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    exitCode: row.exit_code,
    timedOut: row.timed_out === 1,
    timeoutReason: row.timeout_reason,
    truncated: row.truncated === 1,
    logPath: row.log_path,
    evidencePath: row.evidence_path,
    findings: row.findings,
    ordinal: row.ordinal,
    durationMs: row.duration_ms,
    tokens: row.tokens,
    failOn: row.review_fail_on,
    preExisting: indexes(row.review_pre_existing),
    stdout: row.stdout,
    stderr: row.stderr,
  };
}

function indexes(value: string | null): number[] | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((entry): entry is number => Number.isInteger(entry) && entry >= 0);
  } catch {
    return null;
  }
}

function progressKey(itemId: string, identity: CloseoutProgressIdentity): string {
  return [itemId, identity.taskId, identity.base, identity.head, identity.policyDigest].join("\n");
}

function bound(current: string, chunk: string): { text: string; truncated: boolean } {
  if (chunk.length === 0) return { text: current, truncated: false };
  const room = CLOSEOUT_OUTPUT_CAP_BYTES - Buffer.byteLength(current);
  if (room <= 0) return { text: current, truncated: true };
  if (Buffer.byteLength(chunk) <= room) return { text: current + chunk, truncated: false };
  return { text: current + clipUtf8(chunk, room), truncated: true };
}

function clipUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0) {
    const byte = bytes.at(end);
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    end -= 1;
  }
  return bytes.subarray(0, end).toString("utf8");
}

/**
 * Notes on a running step why it has not reached its runner yet. Null clears
 * the note. The step's own state and attempt stay as they are.
 */
export function setRunningCloseoutStepDetail(
  db: Database,
  itemId: string,
  head: string,
  stepId: string,
  detail: string | null,
  now: number,
): void {
  immediate(db, () => {
    db.run(
      `UPDATE closeout_step SET detail = ? WHERE step_id = ? AND state = 'running'
       AND progress_id IN (SELECT id FROM closeout_progress WHERE item_id = ? AND head = ?)`,
      [detail, stepId, itemId, head],
    );
    db.run(
      `UPDATE closeout_progress SET updated_at = ? WHERE item_id = ? AND head = ?
       AND id IN (SELECT progress_id FROM closeout_step WHERE step_id = ? AND state = 'running')`,
      [now, itemId, head, stepId],
    );
  });
}
