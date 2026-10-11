import type { Database } from "bun:sqlite";
import {
  formatPauseNote,
  JOB_KIND,
  OUTBOX_ACTIVITY,
  type Checkpoint,
  type StartupDecision,
  type WakeDecision,
} from "../core";
import {
  applyWorkItemEvent,
  clearProgress,
  failWorkItem,
  getWorkItem,
  saveCheckpoint,
  setCurrentRun,
  setRecoveryAttempts,
  type WorkItemRecord,
} from "./items";
import { cancelOpenJobs, enqueueJobOnce } from "./jobs";
import { enqueueOutboxOnce } from "./outbox";
import { getRun, insertRun, markRun } from "./runs";

export type WakeStamp = { fromWall: number; toWall: number; sleptMs: number };

type Decision = WakeDecision | StartupDecision;

/**
 * Apply one wake or startup decision. Callers wrap a batch in one transaction
 * so the state change, the note, and the follow-up job commit together.
 */
export function applyDecision(
  db: Database,
  item: WorkItemRecord,
  decision: Decision,
  now: number,
  stamp?: WakeStamp,
): void {
  switch (decision.type) {
    case "ignore":
    case "none":
    case "continue":
      return;
    case "resume":
      applyResume(db, item, decision.checkpoint, now);
      return;
    case "restart_session":
      applyRestartSession(db, item, decision.checkpoint, now, stamp);
      return;
    case "restart_from_main":
      applyRestartFromMain(db, item, now, stamp);
      return;
    case "reverify":
      applyReverify(db, item, now, stamp);
      return;
    case "fail":
      applyFail(db, item, decision.reason, now);
      return;
    default: {
      const exhaustive: never = decision;
      throw new Error(`Unhandled decision ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function postPauseNote(
  db: Database,
  item: WorkItemRecord,
  sleptMs: number,
  outcome: "resuming" | "fresh_main",
  fromWall: number,
  now: number,
): void {
  if (item.state === "awaiting_input" || item.state === "paused") return;
  enqueueOutboxOnce(db, {
    target: OUTBOX_ACTIVITY.target,
    op: OUTBOX_ACTIVITY.op,
    orderingKey: item.sessionKey ?? item.id,
    idempotencyKey: `wake:${item.id}:${fromWall}`,
    payload: {
      sessionId: item.sessionKey ?? item.id,
      kind: "thought",
      body: formatPauseNote(sleptMs, outcome),
    },
    now,
  });
}

function applyResume(
  db: Database,
  item: WorkItemRecord,
  checkpoint: Checkpoint,
  now: number,
): void {
  if (item.state === "running" || item.state === "verifying") {
    applyWorkItemEvent(db, item.id, "lease_expired");
  }
  setRecoveryAttempts(db, item.id, 1);
  const current = getWorkItem(db, item.id) ?? item;
  if (current.currentRunId !== null) {
    const run = getRun(db, current.currentRunId);
    if (run && run.status === "lost") markRun(db, run.id, "active", now);
  }
  enqueueJobOnce(db, {
    queue: JOB_KIND.resume,
    jobKey: `resume:${item.id}:${current.version}`,
    payload: {
      itemId: item.id,
      runId: current.currentRunId,
      freshSession: true,
      checkpoint,
      reason: "process_restart",
    },
    now,
  });
}

function applyRestartSession(
  db: Database,
  item: WorkItemRecord,
  checkpoint: Checkpoint,
  now: number,
  stamp?: WakeStamp,
): void {
  if (item.currentRunId !== null) markRun(db, item.currentRunId, "lost", now);
  const run = insertRun(db, {
    itemId: item.id,
    now,
    status: "active",
    checkpoint,
    freshSession: true,
  });
  setCurrentRun(db, item.id, run.id);
  const key = stamp ? `wake-resume:${item.id}:${stamp.fromWall}` : `wake-resume:${item.id}`;
  enqueueJobOnce(db, {
    queue: JOB_KIND.resume,
    jobKey: key,
    payload: {
      itemId: item.id,
      runId: run.id,
      freshSession: true,
      checkpoint,
      reason: "agent_dead",
    },
    now,
  });
}

function applyRestartFromMain(
  db: Database,
  item: WorkItemRecord,
  now: number,
  stamp?: WakeStamp,
): void {
  const wipBranch = item.branchName;
  const previousCheckpoint = item.checkpoint;
  cancelOpenJobs(db, { itemId: item.id, reason: "slept_over_2h", now });
  if (item.currentRunId !== null) markRun(db, item.currentRunId, "lost", now);
  clearProgress(db, item.id);
  const refreshed = getWorkItem(db, item.id);
  if (refreshed && refreshed.state !== "queued") {
    applyWorkItemEvent(db, item.id, "restart");
  }
  const key = stamp ? `fresh-main:${item.id}:${stamp.fromWall}` : `fresh-main:${item.id}:${now}`;
  enqueueJobOnce(db, {
    queue: JOB_KIND.start,
    jobKey: key,
    payload: { itemId: item.id, from: "fresh_main", wipBranch, previousCheckpoint },
    now,
  });
}

function applyReverify(db: Database, item: WorkItemRecord, now: number, stamp?: WakeStamp): void {
  cancelOpenJobs(db, { itemId: item.id, mergeLane: true, reason: "sleep_interrupted_merge", now });
  if (item.checkpoint?.phase === "merge_queue") {
    saveCheckpoint(db, item.id, { ...item.checkpoint, phase: "verifying" });
  }
  if (item.state === "merge_queue") applyWorkItemEvent(db, item.id, "lease_expired");
  const refreshed = getWorkItem(db, item.id) ?? item;
  const key = stamp ? `reverify:${item.id}:${stamp.fromWall}` : `reverify:startup:${item.id}`;
  enqueueJobOnce(db, {
    queue: JOB_KIND.reverify,
    jobKey: key,
    payload: {
      itemId: item.id,
      runId: refreshed.currentRunId,
      recheckHead: true,
      failClosed: true,
    },
    now,
  });
}

function applyFail(
  db: Database,
  item: WorkItemRecord,
  reason: "resume_already_attempted" | "no_checkpoint",
  now: number,
): void {
  const text =
    reason === "resume_already_attempted"
      ? "Stopped after a restart because this run was already resumed once."
      : "Stopped after a restart because there is no checkpoint to resume from.";
  failWorkItem(db, item, reason, text, now);
}
