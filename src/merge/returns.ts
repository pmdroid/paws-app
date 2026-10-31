import type { Database } from "bun:sqlite";
import { JOB_KIND } from "../core";
import {
  type restart,
  fixRounds,
  countRebaseReturns,
  listRebaseReturns,
  getWorkItem,
  immediate,
  recordReviewEscape,
  type WorkItemRecord,
} from "../db";
import type { ask } from "../questions";
import { rebaseBudget, type RebaseBudget, type RebaseConflict } from "./budget";
import type { FailedCiCheck } from "./ci-fix";

export type MergeReturnReason = "rebase-conflict" | "ci-failed";

export function latestUserTurn(db: Database, itemId: string): number {
  const row = db
    .query<{ id: number | null }, [string, string]>(
      `SELECT MAX(id) AS id FROM job
       WHERE queue = ? AND json_extract(payload, '$.itemId') = ?
         AND (job_key LIKE 'linear-turn:%' OR json_extract(payload, '$.reason') = 'answer')`,
    )
    .get(JOB_KIND.resume, itemId);
  return Number(row?.id ?? 0);
}

export function rebaseReturns(db: Database, itemId: string): number {
  return countRebaseReturns(db, itemId, latestUserTurn(db, itemId));
}

/** Whether a conflict on this main may go back to the agent; see {@link rebaseBudget}. */
export function rebaseBudgetFor(
  db: Database,
  itemId: string,
  conflict: RebaseConflict,
  now: number,
): RebaseBudget {
  return rebaseBudget(listRebaseReturns(db, itemId, latestUserTurn(db, itemId)), conflict, now);
}

export function ciFixes(db: Database, itemId: string): number {
  return fixRounds(db, itemId);
}

export function returnToAgent(
  db: Database,
  input: {
    itemId: string;
    restart: typeof restart;
    reason: MergeReturnReason;
    /** Whether one more return is allowed, given the returns already spent. */
    admit: (returns: number) => boolean;
    handoff: string;
    now: number;
    /** Keep the item's merge queue place for when Closeout accepts its rebased head. */
    keepPlace?: boolean;
    record: (jobId: number, attempt: number) => void;
    announce: (running: WorkItemRecord, attempt: number, key: string) => void;
    /** The failed checks of a `ci-failed` return, kept as a candidate review escape. */
    failedChecks?: readonly FailedCiCheck[];
    pullNumber?: number | null;
  },
): "restarted" | "asked" | "skipped" {
  return immediate(db, () => {
    const current = getWorkItem(db, input.itemId);
    if (!current || current.state !== "merge_queue" || current.cancelRequested) return "skipped";
    const returns =
      input.reason === "rebase-conflict" ? rebaseReturns(db, current.id) : ciFixes(db, current.id);
    if (!input.admit(returns)) return "skipped";
    const round = `${latestUserTurn(db, current.id)}:${returns}`;
    const jobKey = `${input.reason}:${current.id}:${round}`;
    const jobId = input.restart(db, current, {
      reason: input.reason === "rebase-conflict" ? "conflict" : "ci",
      body: input.handoff,
      jobKey,
      now: input.now,
      keepMergeQueuePlace: input.keepPlace,
    });
    if (jobId === null)
      return getWorkItem(db, current.id)?.state === "awaiting_input" ? "asked" : "skipped";
    input.announce(current, returns + 1, `${current.id}:${input.reason}:${round}`);
    // CI failed on a head Closeout accepted: a candidate escape of the independent review.
    if (input.reason === "ci-failed" && current.acceptedHead !== null)
      recordReviewEscape(db, {
        triggerKey: jobKey,
        itemId: current.id,
        trigger: "ci",
        acceptedHead: current.acceptedHead,
        pullNumber: input.pullNumber ?? null,
        detail: {
          checks: (input.failedChecks ?? []).map((check) => ({
            name: check.name,
            failsOnBase: check.failsOnBase === true,
          })),
        },
        recordedAt: input.now,
      });
    input.record(jobId, returns + 1);
    return "restarted";
  });
}

export function askMergeHelp(
  db: Database,
  input: {
    itemId: string;
    body: string;
    now: number;
    session: (item: WorkItemRecord) => string | null;
    ask: typeof ask;
    reason?: string;
  },
): boolean {
  return immediate(db, () => {
    const current = getWorkItem(db, input.itemId);
    if (!current || current.state !== "merge_queue" || current.cancelRequested) return false;
    const sessionId = input.session(current);
    if (sessionId === null) return false;
    input.ask(
      db,
      { itemId: current.id, runId: current.currentRunId, sessionId, version: current.version },
      "ci-help",
      input.body,
      {
        now: input.now,
        reason: input.reason ?? "merge_help",
      },
    );
    return true;
  });
}
