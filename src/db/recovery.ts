import type { Database } from "bun:sqlite";
import {
  decideStartup,
  handoffNote,
  JOB_KIND,
  type StartupDecision,
  type WorkItemState,
} from "../core";
import { applyDecision } from "./decisions";
import { enqueueJobOnce } from "./jobs";
import { applyWorkItemEvent, listInFlightItems, listWorkItemsByStates } from "./items";
import type { WorkItemRecord } from "./items";
import { markRun, releaseRunCapacity } from "./runs";
import { getTaskMode } from "./tasks";
import { immediate } from "./tx";

/** Commit dirty files on the item branch. Sync, so shutdown can finish before exit. */
export type ShutdownWipCommit = (item: WorkItemRecord) => void;

const STARTUP_STATES = [
  "running",
  "verifying",
  "recovering",
  "merge_queue",
] as const satisfies readonly WorkItemState[];

/** On process start, resume a live run once or ask whether to start it again. Merges fail closed. */
export function recoverOnStartup(db: Database, now = Date.now()): StartupDecision[] {
  return immediate(db, () => {
    const items = listWorkItemsByStates(db, STARTUP_STATES);
    const decisions: StartupDecision[] = [];
    for (const item of items) {
      if (hasPendingAnswerResume(db, item.id)) continue;
      const decision = decideStartup({
        itemState: item.state,
        recoveryAttempts: item.recoveryAttempts,
        checkpoint: item.checkpoint,
        runnerHoldsWork: runnerHoldsWork(db, item, now),
      });
      applyDecision(db, item, decision, now);
      decisions.push(decision);
    }
    for (const item of listWorkItemsByStates(db, ["awaiting_input"])) {
      if (item.currentRunId !== null) releaseRunCapacity(db, item.currentRunId, now);
      resumeAnsweredQuestion(db, item, now);
    }
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

function resumeAnsweredQuestion(db: Database, item: WorkItemRecord, now: number): void {
  const row = db
    .query<
      { id: string; body: string; options: string | null; status: string; answer: string | null },
      [string]
    >(
      `SELECT id, body, options, status, answer FROM question
       WHERE item_id = ? AND cancelled_at IS NULL
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    )
    .get(item.id);
  if (row?.status !== "answered" || row.answer === null) return;
  const held = db
    .query<{ n: number }, [string, string, string]>(
      `SELECT (
         EXISTS(SELECT 1 FROM closeout_recovery WHERE question_id = ?) +
         EXISTS(SELECT 1 FROM linear_github_auth WHERE question_id = ?) +
         EXISTS(SELECT 1 FROM github_integration_hold WHERE question_id = ?)
       ) AS n`,
    )
    .get(row.id, row.id, row.id);
  if ((held?.n ?? 0) > 0) return;
  applyWorkItemEvent(db, item.id, "answer_received");
  enqueueJobOnce(db, {
    queue: JOB_KIND.resume,
    jobKey: `resume:answer:${row.id}`,
    payload: {
      itemId: item.id,
      freshSession: true,
      handoff: handoffNote({
        question: row.body,
        answer: row.answer,
        ...(row.options === null ? {} : { options: JSON.parse(row.options) }),
      }),
      reason: "answer",
    },
    now,
  });
}

/**
 * SIGINT / SIGTERM. Commit WIP on each in-flight item branch, then move running
 * work to recovering without using the one resume attempt. A merge in progress
 * is left for a re-verify.
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
      } catch {
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
    const merging = listWorkItemsByStates(db, ["merge_queue"]);
    for (const item of merging) {
      if (item.currentRunId !== null) markRun(db, item.currentRunId, "lost", now);
      applyWorkItemEvent(db, item.id, "lease_expired");
    }
  });
}

function runnerHoldsWork(db: Database, item: WorkItemRecord, now: number): boolean {
  const mode = getTaskMode(db, item.id);
  return (
    item.state === "running" &&
    mode !== "answer" &&
    mode !== "artifact" &&
    item.currentRunId !== null &&
    db
      .query("SELECT 1 FROM runner_work WHERE run_id=? AND ended_at IS NULL AND lease_until>?")
      .get(item.currentRunId, now) !== null
  );
}
