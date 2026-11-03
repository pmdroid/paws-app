import type { Database } from "bun:sqlite";
import {
  fixRounds,
  getItemPullRequest,
  pendingPullCiFailures,
  recordCiRound,
  recordReviewEscape,
  settlePullCiFailures,
  type PullCiFailureRecord,
  type WorkItemRecord,
} from "../db";
import { ciFixHandoff, ciFixQuestion, ciFixRoundLine } from "../merge";

export const CI_REVIEW_WAIT_SOURCE =
  "The pull request's own checks failed on its current head while it waited for review. Fixing them does not approve the pull request: it still needs its review before it merges.";

export function currentPullCi(
  db: Database,
  item: WorkItemRecord,
  now: number,
  pullNumber?: number,
): PullCiFailureRecord | null {
  const pending = pendingPullCiFailures(db, item.id);
  const current = pending.filter(
    (failure) =>
      failure.itemVersion === item.version &&
      (pullNumber === undefined || failure.pullNumber === pullNumber),
  );
  const latest = current.at(-1) ?? null;
  settlePullCiFailures(
    db,
    pending.filter((failure) => failure !== latest),
    "dropped",
    now,
  );
  return latest;
}

export function pullCiHandoff(failure: PullCiFailureRecord): string {
  return `${CI_REVIEW_WAIT_SOURCE}\n\n${ciFixHandoff(failure.failedChecks)}`;
}

export function pullCiQuestion(db: Database, failure: PullCiFailureRecord, limit: number): string {
  return ciFixQuestion(
    failure.failedChecks,
    limit,
    getItemPullRequest(db, failure.itemId)?.pullUrl ?? null,
  );
}

export function pullCiRestarted(
  db: Database,
  input: {
    item: WorkItemRecord;
    failure: PullCiFailureRecord;
    jobKey: string;
    limit: number;
    now: number;
  },
): string {
  const { item, failure, now } = input;
  const attempt = fixRounds(db, item.id);
  recordCiRound(db, {
    itemId: item.id,
    head: failure.head,
    runId: item.currentRunId,
    next: "agent",
    fix: attempt,
    fixLimit: input.limit,
    checks: failure.checks,
    recordedAt: now,
  });
  if (item.acceptedHead !== null)
    recordReviewEscape(db, {
      triggerKey: `${input.jobKey}:ci`,
      itemId: item.id,
      trigger: "ci",
      acceptedHead: item.acceptedHead,
      pullNumber: failure.pullNumber,
      detail: {
        checks: failure.failedChecks.map((check) => ({
          name: check.name,
          failsOnBase: check.failsOnBase === true,
        })),
      },
      recordedAt: now,
    });
  settlePullCiFailures(db, [failure], "restarted", now);
  return ciFixRoundLine(failure.failedChecks, attempt, input.limit);
}

export function pullCiAsked(
  db: Database,
  input: { item: WorkItemRecord; failure: PullCiFailureRecord; limit: number; now: number },
): void {
  recordCiRound(db, {
    itemId: input.item.id,
    head: input.failure.head,
    runId: input.item.currentRunId,
    next: "asked",
    fix: null,
    fixLimit: input.limit,
    checks: input.failure.checks,
    recordedAt: input.now,
  });
  settlePullCiFailures(db, [input.failure], "asked", input.now);
}
