import type { Database } from "bun:sqlite";
import { JOB_KIND, type Checkpoint, type StartupDecision } from "../core";
import {
  applyWorkItemEvent,
  failWorkItem,
  getWorkItem,
  saveCheckpoint,
  markResumed,
  type WorkItemRecord,
} from "./items";
import { cancelOpenJobs, enqueueJobOnce } from "./jobs";
import { ensureRestartQuestion, holdRestart, restartQuestionStands } from "./restart-hold";
import { getRun, markRun, releaseRunCapacity } from "./runs";
import { pendingRestartHandoff } from "./restart";
import { getTaskMode } from "./tasks";

/**
 * Apply one startup decision. Callers wrap a batch in one transaction
 * so the state change and the follow-up job commit together.
 */
export function applyDecision(
  db: Database,
  item: WorkItemRecord,
  decision: StartupDecision,
  now: number,
  { runAt = now }: { runAt?: number } = {},
): void {
  switch (decision.type) {
    case "none":
      return;
    case "resume":
      applyResume(db, item, decision.checkpoint, now, runAt, decision.reattach === true);
      return;
    case "reverify":
      applyReverify(db, item, now, decision.resumed === true);
      return;
    case "keep_place":
      applyKeepPlace(db, item, decision.mergeCallInFlight, now);
      return;
    case "ask_restart":
      applyAskRestart(db, item, now);
      return;
    default: {
      const exhaustive: never = decision;
      throw new Error(`Unhandled decision ${JSON.stringify(exhaustive)}`);
    }
  }
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
    !reattach &&
    item.acceptedHead === null &&
    checkpoint === null &&
    getTaskMode(db, item.id) === "code"
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
      ...pendingRestartHandoff(db, item.id),
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
  if (item.state === "running" || item.state === "verifying")
    applyWorkItemEvent(db, item.id, "lease_expired");
  const held = getWorkItem(db, item.id) ?? item;
  holdRestart(db, held, now);
  if (restartQuestionStands(db, held)) return;
  cancelOpenJobs(db, { itemId: item.id, reason: "restart_question", now });
  if (held.currentRunId) releaseRunCapacity(db, held.currentRunId, now);
  ensureRestartQuestion(db, held, now);
}

function applyReverify(db: Database, item: WorkItemRecord, now: number, resumed: boolean): void {
  cancelOpenJobs(db, {
    itemId: item.id,
    reason: resumed ? "interrupted_verification" : "sleep_interrupted_merge",
    now,
  });
  if (resumed) markResumed(db, item.id, now);
  if (item.checkpoint?.phase === "merge_queue") {
    saveCheckpoint(db, item.id, { ...item.checkpoint, phase: "verifying" });
  }
  if (item.state === "merge_queue") applyWorkItemEvent(db, item.id, "lease_expired");
  const refreshed = getWorkItem(db, item.id) ?? item;
  enqueueJobOnce(db, {
    queue: JOB_KIND.reverify,
    jobKey: `reverify:startup:${item.id}:${now}`,
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
