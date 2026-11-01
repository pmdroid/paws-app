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
  markResumed,
  type WorkItemRecord,
} from "./items";
import { cancelOpenJobs, enqueueJobOnce, reenqueueJob } from "./jobs";
import { enqueueOutboxOnce } from "./outbox";
import { getRun, insertRun, markRun, releaseRunCapacity } from "./runs";
import { getTaskMode } from "./tasks";

const RESTART_QUESTION =
  "Paws restarted twice while this task was running. Start it again from its branch in a fresh session? Stop the session to leave it.";

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
  { stamp, runAt = now }: { stamp?: WakeStamp; runAt?: number } = {},
): void {
  switch (decision.type) {
    case "ignore":
    case "none":
    case "continue":
      return;
    case "resume":
      applyResume(db, item, decision.checkpoint, now, runAt, decision.reattach === true);
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
    case "keep_place":
      applyKeepPlace(db, item, decision.mergeCallInFlight, now);
      return;
    case "ask_restart":
      applyAskRestart(db, item, now);
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
  checkpoint: Checkpoint | null,
  now: number,
  runAt: number,
  reattach: boolean,
): void {
  if (!reattach && (item.state === "running" || item.state === "verifying")) {
    applyWorkItemEvent(db, item.id, "lease_expired");
  }
  if (!reattach) markResumed(db, item.id, now);
  const current = getWorkItem(db, item.id) ?? item;
  if (current.currentRunId !== null) {
    const run = getRun(db, current.currentRunId);
    if (run && run.status === "lost") markRun(db, run.id, "active", now);
  }
  const restartHandoff =
    !reattach && checkpoint === null && getTaskMode(db, item.id) === "code"
      ? `Paws restarted before this task saved a checkpoint, and the earlier session is gone. Start again${item.branchName ? ` from the branch ${item.branchName}` : ""}: keep any work already on it and finish the issue.`
      : null;
  enqueueJobOnce(db, {
    queue: JOB_KIND.resume,
    jobKey: `resume:${item.id}:${current.version}:${now}`,
    payload: {
      itemId: item.id,
      runId: current.currentRunId,
      freshSession: true,
      checkpoint,
      ...(restartHandoff === null ? {} : { handoff: restartHandoff }),
      reason: "process_restart",
    },
    runAt,
    now,
  });
}

/** Already resumed once: ask in Linear. Any answer starts the task again through the answer resume. */
function applyAskRestart(db: Database, item: WorkItemRecord, now: number): void {
  if (item.sessionKey === null) {
    failWorkItem(
      db,
      item,
      "resume_already_attempted",
      "Stopped after a restart because this run was already resumed once.",
      now,
    );
    return;
  }
  cancelOpenJobs(db, { itemId: item.id, reason: "restart_question", now });
  if (item.currentRunId) releaseRunCapacity(db, item.currentRunId, now);
  reenqueueJob(db, {
    queue: "item.ask",
    jobKey: `restart-ask:${item.id}:${item.version}`,
    payload: {
      itemId: item.id,
      kind: "agent",
      reason: "restart",
      body: RESTART_QUESTION,
      options: ["Start again"],
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
  const key = stamp
    ? `reverify:${item.id}:${stamp.fromWall}`
    : `reverify:startup:${item.id}:${now}`;
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

/**
 * The item stays in `merge_queue` with its place, and its merge job picks it up again. A job the
 * shutdown ended is queued again from its last payload. After a merge call that may have reached
 * GitHub, the job runs now and asks GitHub first: merged records the merge, anything else re-verifies.
 */
function applyKeepPlace(
  db: Database,
  item: WorkItemRecord,
  mergeCallInFlight: boolean,
  now: number,
): void {
  const open = db
    .query<{ id: number }, [string, string]>(
      `SELECT id FROM job WHERE queue = ? AND status IN ('pending', 'running')
       AND json_extract(payload, '$.itemId') = ?`,
    )
    .all(JOB_KIND.merge, item.id);
  if (open.length > 0) {
    if (mergeCallInFlight)
      for (const { id } of open)
        db.run(
          `UPDATE job SET payload = json_set(payload, '$.mergeCallInFlight', json('true')),
             run_at = MIN(run_at, ?) WHERE id = ?`,
          [now, id],
        );
    return;
  }
  const last = db
    .query<{ payload: string }, [string, string]>(
      `SELECT payload FROM job WHERE queue = ? AND json_extract(payload, '$.itemId') = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(JOB_KIND.merge, item.id);
  const payload = last === null ? { itemId: item.id } : (JSON.parse(last.payload) as object);
  enqueueJobOnce(db, {
    queue: JOB_KIND.merge,
    jobKey: `merge:startup:${item.id}:${now}`,
    payload: mergeCallInFlight ? { ...payload, mergeCallInFlight: true } : payload,
    now,
  });
}

function applyFail(db: Database, item: WorkItemRecord, reason: "no_checkpoint", now: number): void {
  failWorkItem(
    db,
    item,
    reason,
    "Stopped after waking because there is no checkpoint to resume from.",
    now,
  );
}
