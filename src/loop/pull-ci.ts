import type { Database } from "bun:sqlite";
import {
  fixRoundsSteps,
  getItemPullRequestSteps,
  pendingPullCiFailuresSteps,
  recordCiRoundSteps,
  recordReviewEscapeSteps,
  settled,
  settlePullCiFailuresSteps,
  sqliteDb,
  type PullCiFailureRecord,
  type Q,
  type Steps,
  type WorkItemRecord,
} from "../db";
import { ciFixHandoff, ciFixQuestion, ciFixRoundLine } from "../merge";

export const CI_REVIEW_WAIT_SOURCE =
  "The pull request's own checks failed on its current head while it waited for review. Fixing them does not approve the pull request: it still needs its review before it merges.";

/**
 * What a feedback job may hand the agent. `head` is the pull request's head read after the job's
 * last await: a failure on any other head is dropped, and null (no head read) hands over nothing
 * and drops nothing. A failure observed after `observedBy`, the time the job started, arrived
 * while it read GitHub and stays pending for its own collection window.
 */
export type PullCiScope = { pullNumber?: number; head?: string | null; observedBy?: number };

export function currentPullCi(
  db: Database,
  item: WorkItemRecord,
  now: number,
  scope: PullCiScope = {},
): PullCiFailureRecord | null {
  return settled(sqliteDb(db).run((q) => currentPullCiSteps(q, item, now, scope)));
}

export function* currentPullCiSteps(
  q: Q,
  item: WorkItemRecord,
  now: number,
  scope: PullCiScope = {},
): Steps<PullCiFailureRecord | null> {
  const pending = yield* pendingPullCiFailuresSteps(q, item.id);
  const current = pending.filter(
    (failure) =>
      failure.itemVersion === item.version &&
      (scope.pullNumber === undefined || failure.pullNumber === scope.pullNumber),
  );
  const held = current.filter(
    (failure) =>
      scope.head === null ||
      (scope.observedBy !== undefined && failure.observedAt > scope.observedBy),
  );
  const latest =
    current
      .filter(
        (failure) =>
          !held.includes(failure) && (scope.head === undefined || failure.head === scope.head),
      )
      .at(-1) ?? null;
  yield* settlePullCiFailuresSteps(
    q,
    pending.filter((failure) => failure !== latest && !held.includes(failure)),
    "dropped",
    now,
  );
  return latest;
}

/**
 * The pull request's head when a CI failure waits to be handed over, read after every other
 * await so the failure is bound to the head the agent will fix. Null when no failure waits, so
 * one recorded during the job is left for the next; "unreadable" when GitHub cannot be read, and
 * the job waits rather than act on an unconfirmed head.
 */
export async function pullCiHead(
  db: Database,
  item: WorkItemRecord,
  pullNumber: number,
  read: (item: WorkItemRecord, pullNumber: number) => Promise<string | null>,
): Promise<string | null | "unreadable"> {
  if ((await sqliteDb(db).run((q) => pendingPullCiFailuresSteps(q, item.id))).length === 0)
    return null;
  return (await read(item, pullNumber)) ?? "unreadable";
}

export function pullCiHandoff(failure: PullCiFailureRecord): string {
  return `${CI_REVIEW_WAIT_SOURCE}\n\n${ciFixHandoff(
    failure.failedChecks,
    failure.checks.filter((check) => check.waitingForCiFix),
  )}`;
}

export function* pullCiQuestionSteps(
  q: Q,
  failure: PullCiFailureRecord,
  limit: number,
): Steps<string> {
  return ciFixQuestion(
    failure.failedChecks,
    limit,
    (yield* getItemPullRequestSteps(q, failure.itemId))?.pullUrl ?? null,
  );
}

type PullCiRestart = {
  item: WorkItemRecord;
  failure: PullCiFailureRecord;
  jobKey: string;
  limit: number;
  now: number;
};

export function pullCiRestarted(db: Database, input: PullCiRestart): string {
  return settled(sqliteDb(db).transaction((q) => pullCiRestartedSteps(q, input)));
}

export function* pullCiRestartedSteps(q: Q, input: PullCiRestart): Steps<string> {
  const { item, failure, now } = input;
  const attempt = yield* fixRoundsSteps(q, item.id);
  yield* recordCiRoundSteps(q, {
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
    yield* recordReviewEscapeSteps(q, {
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
  yield* settlePullCiFailuresSteps(q, [failure], "restarted", now);
  return ciFixRoundLine(failure.failedChecks, attempt, input.limit);
}

type PullCiAsk = { item: WorkItemRecord; failure: PullCiFailureRecord; limit: number; now: number };

export function pullCiAsked(db: Database, input: PullCiAsk): void {
  settled(sqliteDb(db).transaction((q) => pullCiAskedSteps(q, input)));
}

export function* pullCiAskedSteps(q: Q, input: PullCiAsk): Steps<void> {
  yield* recordCiRoundSteps(q, {
    itemId: input.item.id,
    head: input.failure.head,
    runId: input.item.currentRunId,
    next: "asked",
    fix: null,
    fixLimit: input.limit,
    checks: input.failure.checks,
    recordedAt: input.now,
  });
  yield* settlePullCiFailuresSteps(q, [input.failure], "asked", input.now);
}
