import type { Database } from "bun:sqlite";
import { JOB_KIND } from "../core";
import {
  applyWorkItemEvent,
  countCiFixes,
  countRebaseReturns,
  enqueueJobOnce,
  getWorkItem,
  immediate,
  saveCheckpoint,
  type WorkItemRecord,
} from "../db";
import { ask, findOpenQuestion } from "../questions";

export type MergeReturnReason = "rebase-conflict" | "ci-failed";

export function latestUserTurn(db: Database, itemId: string): number {
  const row = db
    .query<{ id: number | null }, [string, string]>(
      `SELECT MAX(id) AS id FROM job
       WHERE queue = ? AND json_extract(payload, '$.itemId') = ?
         AND job_key LIKE 'linear-turn:%'`,
    )
    .get(JOB_KIND.resume, itemId);
  return Number(row?.id ?? 0);
}

export function rebaseReturns(db: Database, itemId: string): number {
  return countRebaseReturns(db, itemId, latestUserTurn(db, itemId));
}

export function ciFixes(db: Database, itemId: string): number {
  return countCiFixes(db, itemId, latestUserTurn(db, itemId));
}

export function returnToAgent(
  db: Database,
  input: {
    itemId: string;
    reason: MergeReturnReason;
    limit: number;
    handoff: string;
    now: number;
    record: (jobId: number, attempt: number) => void;
    announce: (running: WorkItemRecord, attempt: number, key: string) => void;
  },
): boolean {
  return immediate(db, () => {
    const current = getWorkItem(db, input.itemId);
    if (!current || current.state !== "merge_queue" || current.cancelRequested) return false;
    const returns =
      input.reason === "rebase-conflict" ? rebaseReturns(db, current.id) : ciFixes(db, current.id);
    if (returns >= input.limit) return false;
    const round = `${latestUserTurn(db, current.id)}:${returns}`;
    const running = applyWorkItemEvent(db, current.id, "ejected");
    if (current.checkpoint)
      saveCheckpoint(db, current.id, { ...current.checkpoint, phase: "running" });
    const jobId = enqueueJobOnce(db, {
      queue: JOB_KIND.resume,
      jobKey: `${input.reason}:${current.id}:${round}`,
      payload: { itemId: current.id, handoff: input.handoff, reason: input.reason },
      now: input.now,
    });
    input.record(jobId, returns + 1);
    input.announce(running, returns + 1, `${current.id}:${input.reason}:${round}`);
    return true;
  });
}

export function askMergeHelp(
  db: Database,
  input: {
    itemId: string;
    body: string;
    now: number;
    session: (item: WorkItemRecord) => string | null;
  },
): boolean {
  return immediate(db, () => {
    const current = getWorkItem(db, input.itemId);
    if (!current || current.state !== "merge_queue" || current.cancelRequested) return false;
    const sessionId = input.session(current);
    if (sessionId === null || findOpenQuestion(db, sessionId) !== null) return false;
    ask(db, { itemId: current.id, runId: current.currentRunId, sessionId }, "agent", input.body, {
      now: input.now,
    });
    applyWorkItemEvent(db, current.id, "blocking_question");
    if (current.checkpoint)
      saveCheckpoint(db, current.id, { ...current.checkpoint, phase: "awaiting_input" });
    return true;
  });
}
