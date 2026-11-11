import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  emitJobReady,
  enqueueOutboxOnceSteps,
  getLinearSessionGenerationSteps,
  restartSteps,
  latestHumanTurn,
  latestHumanTurnSteps,
  fixRounds,
  fixRoundsSteps,
  countRebaseReturns,
  countRebaseReturnsSteps,
  listRebaseReturns,
  listRebaseReturnsSteps,
  getWorkItemSteps,
  recordReviewEscapeSteps,
  keepMergeQueuePlaceSteps,
  settled,
  sqliteDb,
  syncSteps,
  type Db,
  type Q,
  type RestartHandoff,
  type Steps,
  type WorkItemRecord,
} from "../db";
import type { ask, askSteps } from "../questions";
import { rebaseBudget, type RebaseBudget, type RebaseConflict } from "./budget";
import type { FailedCiCheck } from "./ci-fix";

export type MergeReturnReason = "rebase-conflict" | "ci-failed" | "policy-invalid";

export type MergeRestart = (item: WorkItemRecord, handoff: RestartHandoff) => number | null;

export function latestUserTurn(db: Database, itemId: string): number {
  return latestHumanTurn(db, itemId);
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

/** {@link rebaseBudgetFor} as Steps, for a caller that runs them on the store. */
export function* rebaseBudgetForSteps(
  q: Q,
  itemId: string,
  conflict: RebaseConflict,
  now: number,
): Steps<RebaseBudget> {
  const turn = yield* latestHumanTurnSteps(q, itemId);
  return rebaseBudget(yield* listRebaseReturnsSteps(q, itemId, turn), conflict, now);
}

const RESTART_REASONS = {
  "rebase-conflict": "conflict",
  "ci-failed": "ci",
  "policy-invalid": "findings",
} as const;

export function ciFixes(db: Database, itemId: string): number {
  return fixRounds(db, itemId);
}

/** The pull request a conflict return is about, for the line in the item's Linear session. */
export type MergeConflictNotice = { sessionId: string | null; pullNumber: number; head: string };

/**
 * Tell the Linear session that main moved and the pull request went back to rebase. The key carries
 * the `merge-conflict:` prefix the activity gate lets through after the pull request response, and
 * the head, so a head is announced once. A thought, so the session shows the agent working again.
 */
export function postMergeConflict(
  db: Database,
  item: WorkItemRecord,
  notice: MergeConflictNotice,
  now: number,
): void {
  settled(sqliteDb(db).transaction((q) => postMergeConflictSteps(q, item, notice, now)));
}

function* postMergeConflictSteps(
  q: Q,
  item: WorkItemRecord,
  notice: MergeConflictNotice,
  now: number,
): Steps<void> {
  if (notice.sessionId === null) return;
  const generation = yield* getLinearSessionGenerationSteps(q, notice.sessionId);
  yield* enqueueOutboxOnceSteps(q, {
    target: "linear",
    op: "activity",
    orderingKey: notice.sessionId,
    idempotencyKey: `merge-conflict:${generation}:${notice.head}`,
    delivery: "critical",
    payload: {
      id: randomUUID(),
      sessionId: notice.sessionId,
      itemId: item.id,
      issueId: item.linearIssueId,
      kind: "thought",
      body: `Main moved and #${notice.pullNumber} now conflicts with it. Rebasing onto main.`,
    },
    now,
  });
}

type MergeReturn = {
  itemId: string;
  reason: MergeReturnReason;
  /** Whether one more return is allowed, given the returns already spent. */
  admit: (q: Q, returns: number) => Steps<boolean>;
  handoff: string;
  now: number;
  /** Keep the item's merge queue place for when Closeout accepts its rebased head. */
  keepPlace?: boolean;
  record: (q: Q, jobId: number, attempt: number) => Steps<void>;
  announce: (running: WorkItemRecord, attempt: number, key: string) => void;
  /** The failed checks of a `ci-failed` return, kept as a candidate review escape. */
  failedChecks?: readonly FailedCiCheck[];
  pullNumber?: number | null;
  restart?: MergeRestart;
  /** Set on a return for a conflict with main: posts the one line in the Linear session. */
  conflict?: MergeConflictNotice;
};

export async function returnToAgent(store: Db, input: MergeReturn): Promise<boolean> {
  const returned = await store.transaction((q) => returnToAgentSteps(q, input));
  if (returned?.armed) emitJobReady(store);
  return returned !== null;
}

function* returnToAgentSteps(q: Q, input: MergeReturn): Steps<{ armed: boolean } | null> {
  const current = yield* getWorkItemSteps(q, input.itemId);
  if (!current || current.state !== "merge_queue" || current.cancelRequested) return null;
  const turn = yield* latestHumanTurnSteps(q, current.id);
  const returns =
    input.reason === "rebase-conflict"
      ? yield* countRebaseReturnsSteps(q, current.id, turn)
      : yield* fixRoundsSteps(q, current.id);
  if (!(yield* input.admit(q, returns))) return null;
  const round = `${turn}:${returns}`;
  input.announce(current, returns + 1, `${current.id}:${input.reason}:${round}`);
  const jobKey = `${input.reason}:${current.id}:${round}`;
  if (input.keepPlace) yield* keepMergeQueuePlaceSteps(q, current.id);
  const handoff = {
    reason: RESTART_REASONS[input.reason],
    body: input.handoff,
    jobKey,
    now: input.now,
  };
  const restarted = input.restart
    ? { id: input.restart(current, handoff), armed: false }
    : ((yield* restartSteps(q, current, handoff)) ?? { id: null, armed: false });
  if (restarted.id === null) return null;
  if (input.conflict) yield* postMergeConflictSteps(q, current, input.conflict, input.now);
  // CI failed on a head Closeout accepted: a candidate escape of the independent review.
  if (input.reason === "ci-failed" && current.acceptedHead !== null)
    yield* recordReviewEscapeSteps(q, {
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
  yield* input.record(q, restarted.id, returns + 1);
  return { armed: restarted.armed };
}

type MergeHelp = {
  itemId: string;
  body: string;
  now: number;
  session: (item: WorkItemRecord) => string | null;
  ask: typeof askSteps;
  reason?: string;
  options?: readonly string[];
};

export function askThrough(db: Database, syncAsk: typeof ask): typeof askSteps {
  return (_q, ...args) => syncSteps(() => syncAsk(db, ...args));
}

export function askMergeHelp(
  db: Database,
  input: Omit<MergeHelp, "ask"> & { ask: typeof ask },
): boolean {
  return settled(
    sqliteDb(db).transaction((q) =>
      askMergeHelpSteps(q, { ...input, ask: askThrough(db, input.ask) }),
    ),
  );
}

export function* askMergeHelpSteps(q: Q, input: MergeHelp): Steps<boolean> {
  const current = yield* getWorkItemSteps(q, input.itemId);
  if (!current || current.state !== "merge_queue" || current.cancelRequested) return false;
  const sessionId = input.session(current);
  if (sessionId === null) return false;
  yield* input.ask(
    q,
    { itemId: current.id, runId: current.currentRunId, sessionId, version: current.version },
    "ci-help",
    input.body,
    {
      now: input.now,
      reason: input.reason ?? "merge_help",
      ...(input.options ? { options: input.options } : {}),
    },
  );
  return true;
}
