import { journalCaught } from "../journal";
import { journal } from "./journal";
import { ownerGone } from "./instances";
import type { Database } from "bun:sqlite";
import { and, desc, eq, inArray, isNotNull, isNull, like, or, sql, type SQL } from "drizzle-orm";
import {
  decideStartup,
  hasVerificationCandidate,
  JOB_KIND,
  MAX_TRANSIENT_RETRIES,
  OUTBOX_ACTIVITY,
  transientRetryDelayMs,
  type StartupDecision,
  type WorkItemState,
} from "../core";
import { applyDecision } from "./decisions";
import { enqueueJobOnce } from "./jobs";
import { enqueueOutboxOnce } from "./outbox";
import {
  applyWorkItemEvent,
  getWorkItem,
  listInFlightItems,
  listWorkItemsByStates,
  saveCheckpoint,
} from "./items";
import type { WorkItemRecord } from "./items";
import {
  markPawsAlive,
  runnerHoldsRunWork,
  runnerLeaseCutoff,
  shiftRunnerLeasesForDowntime,
} from "./runner-lease";
import { mergeCallInFlight } from "./remote-merges";
import { ensureRestartQuestion } from "./restart-hold";
import { claimRun, getRun, markRun, releaseRunCapacity, runOwner } from "./runs";
import { pendingRestartHandoff } from "./restart";
import { orm } from "./orm";
import { job, runnerWork, runnerWorkGrant } from "./schema";
import { immediate } from "./tx";

/** Commit dirty files on the item branch. Sync, so shutdown can finish before exit. */
export type ShutdownWipCommit = (item: WorkItemRecord) => void;

const STARTUP_STATES = [
  "awaiting_input",
  "running",
  "verifying",
  "recovering",
  "merge_queue",
] as const satisfies readonly WorkItemState[];

const STARTUP_RESUME_SPACING_MS = 5_000;

/** The leased job that takes over a gone instance's runs while Paws runs, and how often it runs. */
export const RUN_TAKEOVER_JOB = "run.takeover";
export const RUN_TAKEOVER_MS = 30_000;

/**
 * On process start, resume a live run once or ask whether to start it again. An item in the merge
 * queue keeps its place; one whose merge call may have been in flight asks GitHub before it moves.
 * Paws downtime, up to `offlineBudgetMs`, does not count against an open runner lease. Given
 * `instanceId`, only items whose run has no owner or a gone owner recover, and this instance takes
 * their runs over; a live instance's runs stay with it.
 */
export function recoverOnStartup(
  db: Database,
  now = Date.now(),
  offlineBudgetMs?: number,
  instanceId?: string,
): StartupDecision[] {
  return immediate(db, () => {
    shiftRunnerLeasesForDowntime(db, now, offlineBudgetMs);
    return recoverItems(db, now, instanceId, true);
  });
}

/** Take over and recover, as on startup, the runs of instances that stopped without releasing them. */
export function takeOverGoneRuns(
  db: Database,
  instanceId: string,
  now = Date.now(),
): StartupDecision[] {
  return immediate(db, () => recoverItems(db, now, instanceId, false));
}

function recoverItems(
  db: Database,
  now: number,
  instanceId: string | undefined,
  unowned: boolean,
): StartupDecision[] {
  const takesOver = instanceId === undefined ? () => true : takeoverFilter(db, instanceId, now);
  const items = listWorkItemsByStates(db, STARTUP_STATES).filter((item) =>
    takesOver(item, unowned),
  );
  const decisions: StartupDecision[] = [];
  let resumes = 0;
  const nextResumeAt = () => now + STARTUP_RESUME_SPACING_MS * resumes++;
  for (const item of items) {
    if (instanceId !== undefined && item.currentRunId !== null) {
      const from = runOwner(db, item.currentRunId);
      claimRun(db, item.currentRunId, instanceId);
      if (from !== null)
        journal(
          `run ${item.currentRunId} taken over item=${item.id} from=${from} by=${instanceId}`,
        );
    }
    if (ensureRestartQuestion(db, item, now)) {
      decisions.push({ type: "ask_restart" });
      continue;
    }
    if (hasParkedCapacityWait(db, item)) continue;
    if (hasPendingAnswerResume(db, item.id)) continue;
    if (hasPendingTransientRetry(db, item)) continue;
    const holds = runnerHoldsWork(db, item, now);
    const decision = decideStartup({
      itemState: item.state,
      recoveryAttempts: item.recoveryAttempts,
      checkpoint: item.checkpoint,
      runnerHoldsWork: holds,
      mergeCallInFlight: mergeCallInFlight(db, item.id),
      runActive: runActive(db, item),
      ...(item.resumedAt === null ? {} : { sinceResumeMs: now - item.resumedAt }),
    });
    // A re-verify the shutdown cut short attaches to the runner's Closeout work itself.
    const followed =
      decision.type === "resume"
        ? decision.reattach === true && hasPendingResume(db, item.id, "process_restart")
        : decision.type === "reverify" &&
          holds &&
          item.state === "verifying" &&
          hasOpenReverify(db, item.id);
    if (!followed)
      applyDecision(db, item, decision, now, {
        ...(decision.type === "resume" ? { runAt: nextResumeAt() } : {}),
      });
    decisions.push(decision);
  }
  const taken = new Set(items.map((item) => item.id));
  for (const item of listWorkItemsByStates(db, ["awaiting_input"])) {
    if (taken.has(item.id) && item.currentRunId !== null)
      releaseRunCapacity(db, item.currentRunId, now);
  }
  if (items.some((item) => item.state === "awaiting_input"))
    enqueueJobOnce(db, {
      queue: JOB_KIND.catchup,
      jobKey: `startup-questions:${now}`,
      payload: { reason: "open_questions" },
      now,
    });
  return decisions;
}

/**
 * Whether instance `self` acts on an item: its run's owner is gone, or, with `unowned`, the item
 * has no run or its run no owner.
 */
function takeoverFilter(
  db: Database,
  self: string,
  now: number,
): (item: WorkItemRecord, unowned: boolean) => boolean {
  const gone = ownerGone(db, self, now);
  return (item, unowned) => {
    const owner = item.currentRunId === null ? null : runOwner(db, item.currentRunId);
    return owner === null ? unowned : gone(owner);
  };
}

/** A capacity wait already has its next attempt; restarting neither spends recovery nor adds a job. */
function hasParkedCapacityWait(db: Database, item: WorkItemRecord): boolean {
  if (item.cancelRequested || !["running", "recovering", "verifying"].includes(item.state))
    return false;
  return jobExists(
    db,
    eq(job.status, "pending"),
    inArray(job.queue, [JOB_KIND.start, JOB_KIND.resume, JOB_KIND.reverify]),
    payloadIs("itemId", item.id),
    isNotNull(sql`json_extract(${job.payload}, '$.capacityWait')`),
    or(isNull(job.itemVersion), eq(job.itemVersion, item.version)),
  );
}

function jobExists(db: Database, ...conditions: (SQL | undefined)[]): boolean {
  return (
    orm(db)
      .select({ one: sql`1` })
      .from(job)
      .where(and(...conditions))
      .get() !== undefined
  );
}

function payloadIs(key: "itemId" | "reason", value: string): SQL {
  return sql`json_extract(${job.payload}, ${sql.raw(`'$.${key}'`)}) = ${value}`;
}

function hasPendingAnswerResume(db: Database, itemId: string): boolean {
  return jobExists(
    db,
    inArray(job.status, ["pending", "running"]),
    like(job.jobKey, "resume:answer:%"),
    payloadIs("itemId", itemId),
  );
}

function hasOpenReverify(db: Database, itemId: string): boolean {
  return jobExists(
    db,
    eq(job.queue, JOB_KIND.reverify),
    inArray(job.status, ["pending", "running"]),
    payloadIs("itemId", itemId),
  );
}

function hasPendingTransientRetry(db: Database, item: WorkItemRecord): boolean {
  return jobExists(
    db,
    inArray(job.queue, [JOB_KIND.resume, JOB_KIND.reverify]),
    eq(job.status, "pending"),
    payloadIs("itemId", item.id),
    payloadIs("reason", "transient_failure"),
    or(isNull(job.itemVersion), eq(job.itemVersion, item.version)),
  );
}

function keepsVerification(item: WorkItemRecord): boolean {
  return item.state === "verifying" && hasVerificationCandidate(item.checkpoint);
}

function hasPendingResume(db: Database, itemId: string, reason: string): boolean {
  return jobExists(
    db,
    eq(job.queue, JOB_KIND.resume),
    eq(job.status, "pending"),
    payloadIs("itemId", itemId),
    payloadIs("reason", reason),
  );
}

/**
 * SIGINT / SIGTERM. Commit WIP on each in-flight item branch, then move running
 * work to recovering without using the one resume attempt. Work a runner still
 * holds keeps its state: an agent turn, or a verifying item's Closeout review or
 * check run. An item waiting in
 * the merge queue keeps its state and its place for the next start to pick up; one
 * whose run is still active is left for a re-verify. Given `instanceId`, only items
 * whose run this instance owns, or no instance owns, are touched.
 */
export function prepareShutdown(
  db: Database,
  now = Date.now(),
  commitWip?: ShutdownWipCommit,
  instanceId?: string,
): void {
  const owns = (item: WorkItemRecord) => {
    if (instanceId === undefined || item.currentRunId === null) return true;
    const owner = runOwner(db, item.currentRunId);
    return owner === null || owner === instanceId;
  };
  if (commitWip !== undefined) {
    for (const item of listInFlightItems(db).filter(owns)) {
      try {
        commitWip(item);
      } catch (caughtError1) {
        journalCaught(caughtError1, "recovery.prepareShutdown.commitWip", item.id);
        // The lease move still happens. A missing worktree is not a reason to skip shutdown.
      }
    }
  }
  immediate(db, () => {
    markPawsAlive(db, now);
    const running = listWorkItemsByStates(db, ["running", "verifying"]).filter(owns);
    for (const item of running) {
      if (hasParkedCapacityWait(db, item) || runnerHoldsWork(db, item, now)) continue;
      if (item.currentRunId !== null) markRun(db, item.currentRunId, "lost", now);
      if (!keepsVerification(item)) applyWorkItemEvent(db, item.id, "lease_expired");
    }
    for (const item of listWorkItemsByStates(db, ["merge_queue"]).filter(owns)) {
      if (!runActive(db, item)) continue;
      markRun(db, item.currentRunId!, "lost", now);
      applyWorkItemEvent(db, item.id, "lease_expired");
    }
  });
}

function runActive(db: Database, item: WorkItemRecord): boolean {
  return item.currentRunId !== null && getRun(db, item.currentRunId)?.status === "active";
}

function runnerHoldsWork(db: Database, item: WorkItemRecord, now: number): boolean {
  return (
    (item.state === "running" || item.state === "verifying") &&
    item.currentRunId !== null &&
    runnerHoldsRunWork(db, item.currentRunId, now, item.cancelRequested)
  );
}

const ORPHAN_GRACE_MS = 5 * 60_000;

/** Whether a running job, or a pending one for the item's version, moves work item `i`. */
function progressJobSql(running: SQL = sql`j.status = 'running'`): SQL {
  return sql`EXISTS (SELECT 1 FROM job j WHERE json_extract(j.payload,'$.itemId') = i.id
    AND (${running} OR (j.status = 'pending' AND (j.item_version IS NULL
      OR j.item_version = i.version OR j.queue IN (${JOB_KIND.command}, ${JOB_KIND.reverify})))))`;
}

function reclaimableRunningJobSql(now: number): SQL {
  return sql`(j.status = 'running' AND (j.locked_until IS NULL
  OR j.locked_until > ${now} OR j.item_version IS NULL OR j.item_version = i.version))`;
}

function jobOwnsProgress(db: Database, itemId: string, now: number): boolean {
  return (
    orm(db).all(
      sql`SELECT 1 FROM work_item i WHERE i.id = ${itemId}
        AND ${progressJobSql(reclaimableRunningJobSql(now))}`,
    ).length > 0
  );
}

/**
 * Queue work again for an in-flight item nothing is moving: no pending or running job, no live
 * runner work, and no job finished within the grace period. A merge in progress fails closed into
 * a re-verify, as on startup, so Closeout checks the head before the merge job is queued again.
 */
export function requeueOrphanedWork(db: Database, now: number): string[] {
  const orphans = orm(db).all<{ id: string }>(
    sql`SELECT i.id FROM work_item i
       WHERE i.state IN ('running','verifying','recovering','merge_queue') AND i.cancel_requested = 0
       AND NOT ${progressJobSql()}
       AND NOT EXISTS (SELECT 1 FROM runner_work w WHERE w.run_id = i.current_run_id
         AND w.ended_at IS NULL AND w.lease_until > ${runnerLeaseCutoff(now)})
       AND (SELECT MAX(j.finished_at) FROM job j WHERE json_extract(j.payload,'$.itemId') = i.id)
         < ${now - ORPHAN_GRACE_MS}`,
  );
  const requeued: string[] = [];
  for (const { id } of orphans) {
    const found = getWorkItem(db, id);
    if (!found || ensureRestartQuestion(db, found, now)) continue;
    if (found.state === "merge_queue") applyWorkItemEvent(db, found.id, "lease_expired");
    const item = getWorkItem(db, id) ?? found;
    const key = `orphan:${item.id}:${now}`;
    enqueueJobOnce(db, {
      queue: item.state === "verifying" ? JOB_KIND.reverify : JOB_KIND.resume,
      jobKey: key,
      payload:
        item.state === "verifying"
          ? { itemId: item.id, runId: item.currentRunId, recheckHead: true, failClosed: true }
          : {
              itemId: item.id,
              runId: item.currentRunId,
              freshSession: true,
              checkpoint: item.checkpoint,
              reason: "orphaned",
              ...pendingRestartHandoff(db, item.id),
            },
      now,
    });
    if (item.sessionKey !== null)
      enqueueOutboxOnce(db, {
        target: OUTBOX_ACTIVITY.target,
        op: OUTBOX_ACTIVITY.op,
        orderingKey: item.sessionKey,
        idempotencyKey: key,
        payload: {
          sessionId: item.sessionKey,
          kind: "thought",
          body: `Nothing was moving ${item.linearIdentifier} forward, so Paws picked it up again.`,
        },
        now,
      });
    requeued.push(item.id);
  }
  return requeued;
}

/**
 * Close abandoned runner work once per scheduler dispatch. Live job owners handle their own
 * runner failures; delivered results remain available for import. The item follows its existing
 * lease-expiry transition atomically with the run and slot cleanup.
 */
export function closeExpiredRunnerLeases(db: Database, now: number): string[] {
  return immediate(db, () => {
    const cutoff = runnerLeaseCutoff(now);
    const rows = orm(db).all<{ runId: string; generation: number }>(
      sql`SELECT w.run_id AS runId, w.generation AS generation FROM runner_work w
         JOIN run r ON r.id = w.run_id
         WHERE w.ended_at IS NULL AND w.lease_until <= ${cutoff}
           AND NOT EXISTS (SELECT 1 FROM job j WHERE json_extract(j.payload, '$.itemId')=r.item_id
             AND j.status='running' AND (j.locked_until IS NULL OR j.locked_until> ${now}))
           AND r.status IN ('active', 'provisioning')
           AND NOT EXISTS (SELECT 1 FROM runner_result result
             WHERE result.run_id=w.run_id AND result.generation=w.generation
               AND result.command_id=w.command_id)`,
    );
    for (const row of rows) {
      const run = getRun(db, row.runId)!;
      const item = getWorkItem(db, run.itemId);
      const current =
        item?.currentRunId === row.runId &&
        ["running", "verifying", "merge_queue"].includes(item.state);
      if (current && !keepsVerification(item)) applyWorkItemEvent(db, item.id, "lease_expired");
      markRun(db, row.runId, "lost", now);
      orm(db)
        .update(runnerWork)
        .set({ endedAt: now })
        .where(and(eq(runnerWork.runId, row.runId), isNull(runnerWork.endedAt)))
        .run();
      orm(db).delete(runnerWorkGrant).where(eq(runnerWorkGrant.runId, row.runId)).run();
      if (current) followExpiredLease(db, item, row.generation, now);
    }
    return rows.map((row) => row.runId);
  });
}

function followExpiredLease(
  db: Database,
  before: WorkItemRecord,
  generation: number,
  now: number,
): void {
  const item = getWorkItem(db, before.id);
  if (!item || item.cancelRequested || item.currentRunId !== before.currentRunId) return;
  if (ensureRestartQuestion(db, item, now)) return;
  if (jobOwnsProgress(db, item.id, now) || hasPendingAnswerResume(db, item.id)) return;
  const verify = before.state === "merge_queue" || keepsVerification(before);
  if (verify !== (item.state === "verifying")) return;
  const retry = lastAdvancingRetry(db, item.id) + 1;
  if (retry > MAX_TRANSIENT_RETRIES) {
    applyDecision(db, item, { type: "ask_restart" }, now);
    return;
  }
  if (item.checkpoint?.phase === "merge_queue")
    saveCheckpoint(db, item.id, { ...item.checkpoint, phase: "verifying" });
  const runAt = now + transientRetryDelayMs(retry, null);
  const jobKey = `lease-expired:${item.id}:${before.currentRunId}:${generation}`;
  if (verify)
    enqueueJobOnce(db, {
      queue: JOB_KIND.reverify,
      jobKey,
      runAt,
      maxAttempts: Math.max(1, MAX_TRANSIENT_RETRIES - retry + 1),
      payload: {
        itemId: item.id,
        runId: item.currentRunId,
        reason: "transient_failure",
        retry,
        recheckHead: true,
        failClosed: true,
      },
      now,
    });
  else
    enqueueJobOnce(db, {
      queue: JOB_KIND.resume,
      jobKey,
      runAt,
      payload: {
        itemId: item.id,
        runId: item.currentRunId,
        reason: "transient_failure",
        retry,
        ...pendingRestartHandoff(db, item.id),
      },
      now,
    });
}

function lastAdvancingRetry(db: Database, itemId: string): number {
  const row = orm(db)
    .select({ retry: sql<unknown>`json_extract(${job.payload}, '$.retry')` })
    .from(job)
    .where(
      and(
        inArray(job.queue, [JOB_KIND.start, JOB_KIND.resume, JOB_KIND.reverify]),
        payloadIs("itemId", itemId),
      ),
    )
    .orderBy(desc(job.id))
    .limit(1)
    .get();
  return typeof row?.retry === "number" ? row.retry : 0;
}
