import { journalCaught } from "../journal";
import type { Database } from "bun:sqlite";
import {
  decideStartup,
  isResponseTaskMode,
  JOB_KIND,
  OUTBOX_ACTIVITY,
  type StartupDecision,
  type WorkItemState,
} from "../core";
import { applyDecision } from "./decisions";
import { enqueueJobOnce } from "./jobs";
import { enqueueOutboxOnce } from "./outbox";
import { applyWorkItemEvent, getWorkItem, listInFlightItems, listWorkItemsByStates } from "./items";
import type { WorkItemRecord } from "./items";
import { runnerLeaseCutoff } from "./runner-lease";
import { mergeCallInFlight } from "./remote-merges";
import { getRun, markRun, releaseRunCapacity } from "./runs";
import { getTaskMode } from "./tasks";
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

/**
 * On process start, resume a live run once or ask whether to start it again. An item in the merge
 * queue keeps its place; one whose merge call may have been in flight asks GitHub before it moves.
 */
export function recoverOnStartup(db: Database, now = Date.now()): StartupDecision[] {
  return immediate(db, () => {
    const items = listWorkItemsByStates(db, STARTUP_STATES);
    const decisions: StartupDecision[] = [];
    let resumes = 0;
    const nextResumeAt = () => now + STARTUP_RESUME_SPACING_MS * resumes++;
    for (const item of items) {
      if (hasPendingAnswerResume(db, item.id)) continue;
      if (hasPendingResume(db, item.id, "transient_failure")) continue;
      const decision = decideStartup({
        itemState: item.state,
        recoveryAttempts: item.recoveryAttempts,
        checkpoint: item.checkpoint,
        runnerHoldsWork: runnerHoldsWork(db, item, now),
        mergeCallInFlight: mergeCallInFlight(db, item.id),
        runActive: runActive(db, item),
        ...(item.resumedAt === null ? {} : { sinceResumeMs: now - item.resumedAt }),
      });
      const followed =
        decision.type === "resume" &&
        decision.reattach === true &&
        hasPendingResume(db, item.id, "process_restart");
      if (!followed)
        applyDecision(db, item, decision, now, {
          ...(decision.type === "resume" ? { runAt: nextResumeAt() } : {}),
        });
      decisions.push(decision);
    }
    for (const item of listWorkItemsByStates(db, ["awaiting_input"])) {
      if (item.currentRunId !== null) releaseRunCapacity(db, item.currentRunId, now);
    }
    if (items.some((item) => item.state === "awaiting_input"))
      enqueueJobOnce(db, {
        queue: JOB_KIND.catchup,
        jobKey: `startup-questions:${now}`,
        payload: { reason: "open_questions" },
        now,
      });
    return decisions;
  });
}

function hasPendingAnswerResume(db: Database, itemId: string): boolean {
  return (
    db
      .query(
        `SELECT 1 FROM job WHERE status IN ('pending', 'running') AND job_key LIKE 'resume:answer:%'
         AND json_extract(payload, '$.itemId') = ?`,
      )
      .get(itemId) !== null
  );
}

function hasPendingResume(db: Database, itemId: string, reason: string): boolean {
  return (
    db
      .query(
        `SELECT 1 FROM job WHERE queue = ? AND status = 'pending'
         AND json_extract(payload, '$.itemId') = ? AND json_extract(payload, '$.reason') = ?`,
      )
      .get(JOB_KIND.resume, itemId, reason) !== null
  );
}

/**
 * SIGINT / SIGTERM. Commit WIP on each in-flight item branch, then move running
 * work to recovering without using the one resume attempt. An item waiting in
 * the merge queue keeps its state and its place for the next start to pick up; one
 * whose run is still active is left for a re-verify.
 */
export function prepareShutdown(
  db: Database,
  now = Date.now(),
  commitWip?: ShutdownWipCommit,
): void {
  if (commitWip !== undefined) {
    for (const item of listInFlightItems(db)) {
      try {
        commitWip(item);
      } catch (caughtError1) {
        journalCaught(caughtError1, "recovery.prepareShutdown.commitWip", item.id);
        // The lease move still happens. A missing worktree is not a reason to skip shutdown.
      }
    }
  }
  immediate(db, () => {
    const running = listWorkItemsByStates(db, ["running", "verifying"]);
    for (const item of running) {
      if (runnerHoldsWork(db, item, now)) continue;
      if (item.currentRunId !== null) markRun(db, item.currentRunId, "lost", now);
      applyWorkItemEvent(db, item.id, "lease_expired");
    }
    for (const item of listWorkItemsByStates(db, ["merge_queue"])) {
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
  const mode = getTaskMode(db, item.id);
  return (
    item.state === "running" &&
    !isResponseTaskMode(mode) &&
    item.currentRunId !== null &&
    db
      .query(
        `SELECT 1 FROM runner_work w WHERE w.run_id=?1 AND w.ended_at IS NULL AND (w.lease_until>?2 OR
         (?3=0 AND EXISTS(SELECT 1 FROM runner_result r
           WHERE r.run_id=w.run_id AND r.generation=w.generation AND r.command_id=w.command_id)))`,
      )
      .get(item.currentRunId, runnerLeaseCutoff(now), item.cancelRequested ? 1 : 0) !== null
  );
}

const ORPHAN_GRACE_MS = 5 * 60_000;

/**
 * Queue work again for an in-flight item nothing is moving: no pending or running job, no live
 * runner work, and no job finished within the grace period. A merge in progress fails closed into
 * a re-verify, as on startup, so Closeout checks the head before the merge job is queued again.
 */
export function requeueOrphanedWork(db: Database, now: number): string[] {
  const orphans = db
    .query<{ id: string }, [number, number]>(
      `SELECT i.id FROM work_item i
       WHERE i.state IN ('running','verifying','recovering','merge_queue') AND i.cancel_requested = 0
       AND NOT EXISTS (SELECT 1 FROM job j WHERE j.status IN ('pending','running')
         AND json_extract(j.payload,'$.itemId') = i.id)
       AND NOT EXISTS (SELECT 1 FROM runner_work w WHERE w.run_id = i.current_run_id
         AND w.ended_at IS NULL AND w.lease_until > ?1)
       AND (SELECT MAX(j.finished_at) FROM job j WHERE json_extract(j.payload,'$.itemId') = i.id) < ?2`,
    )
    .all(runnerLeaseCutoff(now), now - ORPHAN_GRACE_MS);
  const requeued: string[] = [];
  for (const { id } of orphans) {
    const found = getWorkItem(db, id);
    if (!found) continue;
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
