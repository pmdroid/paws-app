import { mergeStopRequested } from "../db";
import type { ask } from "../questions";
import { journal, journalCaught } from "../journal";
import type { Database } from "bun:sqlite";
import { mergeQueueLine, type RepositoryBinding } from "../core";
import {
  artifactPublicationReady,
  clearPullCiFailures,
  getItemPullRequest,
  getLinearSessionGenerationSteps,
  getWorkItem,
  getWorkItemSteps,
  immediate,
  joinMergeQueueSteps,
  leaveMergeQueueSteps,
  markMergeQueueNotifiedSteps,
  mergeQueuePosition,
  pendingChangeRequests,
  pendingPullCiFailures,
  pendingLinearComments,
  pendingPullComments,
  pullReviewCheckWait,
  rebaseReturnedForSteps,
  recordPullCiFailure,
  settlePullCiFailures,
  wakePullReviews,
  recordCiRound,
  recordConfirmedRemoteMergeSteps,
  recordRebaseReturn,
  type CiRound,
  type CiRoundCheck,
  type Db,
  type PullFeedbackWait,
  type WorkItemRecord,
} from "../db";
import {
  githubQueueLine,
  githubQueueMerge,
  readPullReview,
  type GitHubBinding,
  type PullCi,
  type PullMergeable,
} from "../github";
import { ciFixHandoff, ciFixQuestion, ciFixRoundLine, type FailedCiCheck } from "./ci-fix";
import type { RebaseConflict } from "./budget";
import {
  askMergeHelp,
  rebaseBudgetFor,
  returnToAgent,
  type MergeRestart,
  type MergeReturnReason,
} from "./returns";
import type { MergeStep } from "./step";
import { ciWaitVerification, githubQueueWatch, type MergeWait } from "./wait";

export const REBASE_CONFLICT_INSTRUCTION =
  "The pull request no longer rebases cleanly onto main. Paws already fetched main into origin/main in your checkout. Rebase this branch onto origin/main without fetching again and without a merge commit, resolve every conflict so the change still does what the issue asks, and run the checks again.";
export const REBASE_CONFLICT_THOUGHT =
  "Main moved and the branch conflicts. Sent it back to the agent to rebase.";
const CI_FIX_SOURCE = {
  pull: "The pull request's own checks failed before Paws could add it to the GitHub merge queue.",
  queue:
    "GitHub's merge queue removed the pull request because a check failed on the combined commit it tested with the pull requests ahead of it. Main may have changed since this branch was made.",
};

/**
 * A changes-requested review or a pull request comment that has not reached the agent yet holds
 * the merge. Checked before the merge work and again, synchronously, right before the squash or
 * enqueue call: webhook ingestion runs on the same thread, so feedback recorded before that call
 * always wins.
 */
export function reviewHold(
  db: Database,
  itemId: string,
  now: number,
  wait: PullFeedbackWait,
): MergeStep | null {
  if (!feedbackPending(db, itemId)) return null;
  if (!pullFeedbackPending(db, itemId))
    return {
      kind: "wait",
      message: "A comment on the Linear issue goes to the agent before this pull request merges.",
      queued: true,
      reason: "review",
    };
  wakePullReviews(db, itemId, now, wait);
  const checks = pullReviewCheckWait(db, itemId);
  return {
    kind: "wait",
    message: checks
      ? `Waiting for review checks on ${checks.head.slice(0, 7)}: ${checks.names.join(", ")}.`
      : "Requested changes go back to the agent before this pull request merges.",
    queued: true,
    reason: "review",
  };
}

export async function feedbackHold(
  merge: MergeContext,
  payload: unknown,
): Promise<MergeStep | null> {
  const { db, item, caps } = merge;
  if (!feedbackPending(db, item.id)) return null;
  const pull = getItemPullRequest(db, item.id);
  const head = ciWaitVerification(payload)?.head ?? item.checkpoint?.wipCommit;
  if (pull !== null && head) await observeHeldCi(merge, { number: pull.pullNumber, head });
  if (caps.stopped()) return { kind: "obsolete" };
  return reviewHold(db, item.id, caps.now(), caps.feedbackWait());
}

export async function observeHeldCi(
  { db, item, caps }: MergeContext,
  pull: { number: number; head: string },
): Promise<void> {
  const ci = await caps.readPullCi(item, pull).catch((error: unknown): PullCi => {
    journalCaught(error, "orders.observeHeldCi.readPullCi", item.id);
    return { state: "unknown", message: "could not read GitHub CI" };
  });
  if (caps.stopped() || (ci.state === "unknown" && ci.moved !== true)) return;
  immediate(db, () => {
    const current = getWorkItem(db, item.id);
    if (
      current === null ||
      current.version !== item.version ||
      current.state !== "merge_queue" ||
      current.cancelRequested ||
      mergeStopRequested(db, item.id)
    )
      return;
    if (ci.state === "unknown") {
      settlePullCiFailures(db, pendingPullCiFailures(db, item.id), "dropped", caps.now());
      return;
    }
    if (ci.state !== "failed") {
      clearPullCiFailures(db, item.id, pull.head, caps.now());
      return;
    }
    recordPullCiFailure(
      db,
      {
        itemId: item.id,
        head: pull.head,
        pullNumber: pull.number,
        itemVersion: current.version,
        failedChecks: ci.failedChecks,
        checks: ci.checks,
        observedAt: caps.now(),
      },
      caps.feedbackWait(),
    );
  });
}

/** Whether the merge call must not be made now: stopped, artifacts missing, or a review pending. */
export function mergeHeld({ db, item, caps }: MergeContext): boolean {
  return (
    caps.stopped() ||
    mergeStopRequested(db, item.id) ||
    !artifactPublicationReady(db, item.id) ||
    feedbackPending(db, item.id)
  );
}

function feedbackPending(db: Database, itemId: string): boolean {
  return pullFeedbackPending(db, itemId) || pendingLinearComments(db, itemId).length > 0;
}

function pullFeedbackPending(db: Database, itemId: string): boolean {
  if (pendingChangeRequests(db, itemId).length > 0 || pendingPullComments(db, itemId).length > 0)
    return true;
  const version = getWorkItem(db, itemId)?.version;
  return pendingPullCiFailures(db, itemId).some((failure) => failure.itemVersion === version);
}

export type MergeVoice = {
  thought(item: WorkItemRecord, body: string, key: string): void;
  status(item: WorkItemRecord, body: string, key: string): void;
  afterPullRequest(item: WorkItemRecord, body: string, key: string): void;
  flush(): Promise<void>;
};

export type OrderCapabilities = {
  ask: typeof ask;
  now(): number;
  stopped(): boolean;
  session(item: WorkItemRecord): string | null;
  /** Fetch main into the item's worktree. Main's commit, or null without a worktree. */
  fetchMain(item: WorkItemRecord): Promise<string | null>;
  ciFixAttempts(item: WorkItemRecord): number;
  feedbackWait(): PullFeedbackWait;
  readPullCi(item: WorkItemRecord, pull: { number: number; head: string }): Promise<PullCi>;
  /** GitHub's `mergeable` for the item's pull request, read again while GitHub computes it. */
  readPull(item: WorkItemRecord, pullNumber: number): Promise<PullMergeable | null>;
  /**
   * Null when the task's Linear dependencies let it merge. Otherwise the identifiers of the
   * blockers it waits for, empty when none can be named. A held task takes no place in the queue.
   */
  dependencyHold(itemId: string): readonly string[] | null;
  /**
   * The merge-queue lane the task joins in its repository: its Linear project id, or `''` for the
   * repository-wide lane.
   */
  mergeLane(item: WorkItemRecord): string;
  restart?: MergeRestart;
  voice: MergeVoice;
};

export type MergeContext = {
  db: Database;
  store: Db;
  item: WorkItemRecord;
  caps: OrderCapabilities;
};

export type MergePull = {
  github: GitHubBinding;
  repository: RepositoryBinding;
  pull: { number: number; url: string | null };
  head: string;
  signal: AbortSignal;
};

export function sendBack(
  { db, item, caps }: MergeContext,
  reason: MergeReturnReason,
  admit: (returns: number) => boolean,
  handoff: string,
  report: {
    thought: (attempt: number) => string;
    record: (jobId: number, attempt: number) => void;
    failedChecks?: readonly FailedCiCheck[];
    pullNumber?: number | null;
  },
): boolean {
  return returnToAgent(db, {
    itemId: item.id,
    reason,
    admit,
    handoff,
    now: caps.now(),
    record: report.record,
    ...(report.failedChecks ? { failedChecks: report.failedChecks } : {}),
    ...(report.pullNumber !== undefined ? { pullNumber: report.pullNumber } : {}),
    ...(caps.restart ? { restart: caps.restart } : {}),
    announce: (running, attempt, key) => {
      if (reason === "ci-failed") caps.voice.status(running, report.thought(attempt), key);
      else caps.voice.thought(running, report.thought(attempt), key);
    },
  });
}

export function askHelp(
  { db, item, caps }: MergeContext,
  body: string,
  reason = "merge_help",
  options?: readonly string[],
): boolean {
  return askMergeHelp(db, {
    itemId: item.id,
    body,
    reason,
    ...(options ? { options } : {}),
    now: caps.now(),
    session: caps.session,
    ask: caps.ask,
  });
}

export function ciRound(
  { db, item, caps }: MergeContext,
  head: string,
  checks: readonly CiRoundCheck[] | undefined,
  next: CiRound["next"],
  limit: number,
  fix: number | null,
): void {
  recordCiRound(db, {
    itemId: item.id,
    head,
    runId: getWorkItem(db, item.id)?.currentRunId ?? item.currentRunId,
    next,
    fix,
    fixLimit: limit,
    checks: [...(checks ?? [])],
    recordedAt: caps.now(),
  });
}

export async function mergeQueueTurn(
  { db, store, item, caps }: MergeContext,
  repository: { owner: string; repo: string },
  github: GitHubBinding,
  pull: { number: number; url: string | null; head: string },
): Promise<MergeWait | Extract<MergeStep, { kind: "returned" | "asked" }> | undefined> {
  const prNumber = pull.number;
  const name = `${repository.owner}/${repository.repo}`;
  const held = (itemId: string) => caps.dependencyHold(itemId) !== null;
  const review = await readPullReview({
    client: github.client,
    owner: repository.owner,
    repo: repository.repo,
    prNumber,
    ...credentials(github),
  });
  if (caps.stopped()) return undefined;
  if (review === "unreadable" && mergeQueuePosition(db, item.id, held) === null)
    return {
      message: "Could not read the pull request's reviews.",
      queued: true,
      reason: "review",
    };
  if (review === "required" || review === "changes_requested") {
    await store.run((q) => leaveMergeQueueSteps(q, item.id));
    // Reviewers do not approve a conflicting pull request, so the rebase does not wait for them.
    const conflict = await reviewWaitConflict({ db, store, item, caps }, pull.number);
    if (caps.stopped()) return undefined;
    if (conflict) return conflict;
    const body =
      review === "required"
        ? `Waiting for an approving review on pull request #${prNumber}. It joins the ${name} merge queue once approved.`
        : `Changes were requested on pull request #${prNumber}. It joins the ${name} merge queue once approved.`;
    const notice = reviewWaitNotice(review, prNumber, pull.url, name);
    const key = await reviewWaitKey(store, item, caps, review, pull.head);
    caps.voice.afterPullRequest(item, notice, key);
    await observeHeldCi({ db, store, item, caps }, pull);
    if (caps.stopped()) return undefined;
    return { message: body, queued: true, reason: "review" };
  }
  await store.run((q) =>
    joinMergeQueueSteps(q, {
      itemId: item.id,
      repository: name,
      lane: caps.mergeLane(item),
      now: caps.now(),
    }),
  );
  const place = mergeQueuePosition(db, item.id, held);
  if (place === null) return undefined;
  // A busy task ahead keeps its place but does not hold the lane: the first ready task moves.
  const nextId = place.nextItemId;
  const next = nextId ? await store.run((q) => getWorkItemSteps(q, nextId)) : null;
  const first = `${next?.linearIdentifier ?? "The task ahead"} merges first.`;
  if (
    place.notifiedPosition !== place.position &&
    (place.position > 1 || place.notifiedPosition !== null)
  ) {
    const line = mergeQueueLine(place);
    const body = place.nextItemId === null ? `${line}. Merging next.` : `${line}. ${first}`;
    caps.voice.status(item, body, `${item.id}:merge-queue:${place.readyAt}:${place.position}`);
    await store.run((q) => markMergeQueueNotifiedSteps(q, item.id, place.position));
  }
  if (place.nextItemId === null) return undefined;
  return { message: `${mergeQueueLine(place)}. ${first}`, queued: true, reason: "ahead" };
}

/**
 * A pull request waiting for a review that no longer merges into main goes back to rebase, through
 * the lane's conflict return and rebase budget; with the budget spent Paws asks. Null when it
 * merges cleanly, GitHub has not computed `mergeable`, or this head already went back once.
 */
async function reviewWaitConflict(
  merge: MergeContext,
  prNumber: number,
): Promise<Extract<MergeStep, { kind: "returned" | "asked" }> | null> {
  const { db, store, item, caps } = merge;
  const read = await caps.readPull(item, prNumber);
  if (caps.stopped() || read === null || !read.open || read.merges !== "conflict") return null;
  if (await store.run((q) => rebaseReturnedForSteps(q, item.id, read.head))) return null;
  const base = await caps.fetchMain(item).catch((error: unknown) => {
    journalCaught(error, "orders.reviewWaitConflict.fetchMain", item.id);
    return null;
  });
  if (caps.stopped() || base === null) return null;
  const conflict: RebaseConflict = { base, files: null };
  const found = `item ${item.linearIdentifier} pull request #${prNumber} at ${read.head.slice(0, 7)} conflicts with main while it waits for a review`;
  if (
    sendBack(
      merge,
      "rebase-conflict",
      () => rebaseBudgetFor(db, item.id, conflict, caps.now()).allowed,
      REBASE_CONFLICT_INSTRUCTION,
      {
        thought: () => REBASE_CONFLICT_THOUGHT,
        record: (jobId) =>
          recordRebaseReturn(db, {
            itemId: item.id,
            jobId,
            candidate: read.head,
            reason: "merge",
            ...conflict,
            recordedAt: caps.now(),
          }),
      },
    )
  ) {
    journal(`${found}: sent back to the agent to rebase`);
    return { kind: "returned" };
  }
  const budget = rebaseBudgetFor(db, item.id, conflict, caps.now());
  if (
    budget.allowed ||
    !askHelp(
      merge,
      `${budget.message} Reply with guidance to continue, or stop the task.`,
      "rebase_budget_spent",
    )
  )
    return null;
  journal(`${found}: the rebase budget is spent, asked for guidance`);
  await caps.voice.flush();
  return { kind: "asked" };
}

function reviewWaitNotice(
  review: "required" | "changes_requested",
  prNumber: number,
  url: string | null,
  repository: string,
): string {
  const pull = url === null ? `pull request #${prNumber}` : `[pull request #${prNumber}](${url})`;
  return review === "required"
    ? `Waiting for an approving review on ${pull}. It joins the ${repository} merge queue once approved.`
    : `Changes were requested on ${pull}. Paws collects the review feedback before the next fix turn, and the pull request joins the ${repository} merge queue once approved.`;
}

async function reviewWaitKey(
  store: Db,
  item: WorkItemRecord,
  caps: OrderCapabilities,
  review: string,
  head: string,
): Promise<string> {
  const session = caps.session(item);
  const generation =
    session === null ? 0 : await store.run((q) => getLinearSessionGenerationSteps(q, session));
  return `merge-review:${item.id}:${generation}:${review}:${head}`;
}

export async function mergeThroughGitHubQueue(
  merge: MergeContext,
  payload: unknown,
  published: MergePull,
): Promise<MergeStep | "no_queue"> {
  const { db, store, item, caps } = merge;
  const { repository, github, pull, head } = published;
  const name = `${repository.owner}/${repository.repo}`;
  const watch = githubQueueWatch(payload) ?? { queued: false };
  const result = await githubQueueMerge({
    owner: repository.owner,
    repo: repository.repo,
    prNumber: pull.number,
    head,
    client: github.client,
    appId: github.appId,
    installationId: github.installationId,
    privateKeyPem: github.privateKeyPem,
    ...(github.tokenProvider ? { tokenProvider: github.tokenProvider } : {}),
    queued: watch.queued,
    isCancelled: () => mergeHeld(merge),
    signal: published.signal,
  });
  if (caps.stopped()) return { kind: "obsolete" };
  // The review job may take the pull request out of GitHub's queue meanwhile; that removal is
  // the review's, not a person's or a failed check's.
  if (result.outcome !== "merged") {
    const held = reviewHold(db, item.id, caps.now(), caps.feedbackWait());
    if (held) return held;
  }
  switch (result.outcome) {
    case "no_queue":
      caps.voice.status(
        item,
        `${result.message} Paws merges the pull request itself when its CI is green.`,
        `${item.id}:github-queue:none:${head}`,
      );
      return "no_queue";
    case "checks_pending":
    case "unreadable":
      return { kind: "wait", message: result.message, head, reason: "ci", githubQueue: watch };
    case "queued": {
      const line = githubQueueLine(name, result.position, result.state);
      if (!watch.queued)
        caps.voice.status(
          item,
          `Added ${pull.url ?? `pull request #${pull.number}`} to the GitHub merge queue. ${line}`,
          `${item.id}:github-queue:added:${head}`,
        );
      else if (watch.position !== result.position || watch.state !== result.state)
        caps.voice.status(
          item,
          line,
          `${item.id}:github-queue:${head}:${result.position}:${result.state}`,
        );
      await caps.voice.flush();
      return {
        kind: "wait",
        message: line,
        head,
        reason: (result.position ?? 1) > 1 ? "ahead" : "ci",
        githubQueue: { queued: true, position: result.position, state: result.state, line },
      };
    }
    case "merged":
      await store.transaction((q) =>
        recordConfirmedRemoteMergeSteps(q, {
          itemId: item.id,
          repositoryOwner: repository.owner,
          repositoryName: repository.repo,
          pullNumber: pull.number,
          pullUrl: pull.url,
          mergeSha: result.sha,
          confirmedAt: caps.now(),
        }),
      );
      return { kind: "merged" };
    case "ci_failed":
      return githubQueueCiFailed(merge, head, result.failedChecks, pull, CI_FIX_SOURCE.pull);
    case "removed": {
      const { removal } = result;
      const why = removal.reason ? ` (${removal.reason})` : "";
      if (removal.cause === "failed")
        return githubQueueCiFailed(
          merge,
          head,
          [{ name: removal.reason || "merge queue checks", url: pull.url }],
          pull,
          CI_FIX_SOURCE.queue,
        );
      if (removal.cause === "conflict") {
        const base = await caps.fetchMain(item).catch((caughtError1) => {
          journalCaught(caughtError1, "orders.mergeThroughGitHubQueue.fetchMain", item?.id);
          return null;
        });
        const conflict: RebaseConflict = { base, files: null };
        const budget = rebaseBudgetFor(db, item.id, conflict, caps.now());
        if (
          base !== null &&
          sendBack(
            merge,
            "rebase-conflict",
            () => rebaseBudgetFor(db, item.id, conflict, caps.now()).allowed,
            REBASE_CONFLICT_INSTRUCTION,
            {
              thought: () =>
                `GitHub's merge queue removed the pull request for a conflict${why}. Sent it back to the agent to rebase.`,
              record: (jobId) =>
                recordRebaseReturn(db, {
                  itemId: item.id,
                  jobId,
                  candidate: head,
                  reason: "github_queue",
                  ...conflict,
                  recordedAt: caps.now(),
                }),
            },
          )
        )
          return { kind: "returned" };
        const message = `GitHub's merge queue removed the pull request for a conflict${why}.${budget.allowed ? "" : ` ${budget.message}`}`;
        if (
          askHelp(
            merge,
            `${message} Reply with guidance to continue, or stop the task.`,
            budget.allowed ? "merge_help" : "rebase_budget_spent",
          )
        ) {
          await caps.voice.flush();
          return { kind: "asked" };
        }
        return { kind: "failed", reason: "merge", message };
      }
      return askGitHubQueueRemoval(
        merge,
        `${removal.actor ? `@${removal.actor}` : "Someone"} removed ${pull.url ?? `pull request #${pull.number}`} from the ${name} GitHub merge queue${why}.`,
      );
    }
    case "closed":
      return askGitHubQueueRemoval(
        merge,
        `${pull.url ?? `Pull request #${pull.number}`} was closed on GitHub while it waited for the ${name} merge queue.`,
      );
    case "blocked":
    case "sha_moved":
      return { kind: "failed", reason: "merge", message: result.message };
  }
}

async function githubQueueCiFailed(
  merge: MergeContext,
  head: string,
  checks: readonly FailedCiCheck[],
  pull: { number: number; url: string | null },
  source: string,
): Promise<MergeStep> {
  const limit = merge.caps.ciFixAttempts(merge.item);
  const failed = checks.map((check) => ({
    name: check.name,
    state: "failed" as const,
    url: check.url,
    startedAt: null,
    completedAt: null,
    logTail: check.logTail ?? null,
    logSource: null,
  }));
  if (
    sendBack(merge, "ci-failed", (fixes) => fixes < limit, `${source}\n\n${ciFixHandoff(checks)}`, {
      thought: (attempt) => ciFixRoundLine(checks, attempt, limit),
      record: (_, attempt) => ciRound(merge, head, failed, "agent", limit, attempt),
      failedChecks: checks,
      pullNumber: pull.number,
    })
  )
    return { kind: "returned" };
  if (askHelp(merge, ciFixQuestion(checks, limit, pull.url), "budget_spent")) {
    await merge.caps.voice.flush();
    return { kind: "asked" };
  }
  return {
    kind: "failed",
    reason: "merge",
    message: `CI failed: ${checks.map((check) => check.name).join(", ")}`,
  };
}

async function askGitHubQueueRemoval(merge: MergeContext, what: string): Promise<MergeStep> {
  const body = [
    what,
    "",
    "What should Paws do? Reply with what to change, and the agent works on it. Paws adds the pull request to the merge queue again after Closeout accepts the change. To leave it as it is, stop the task.",
  ].join("\n");
  if (askHelp(merge, body)) {
    await merge.caps.voice.flush();
    return { kind: "asked" };
  }
  return { kind: "failed", reason: "merge", message: what };
}

function credentials(
  github: GitHubBinding,
):
  | { tokenProvider: NonNullable<GitHubBinding["tokenProvider"]> }
  | { appId: string; installationId: string; privateKeyPem: string } {
  if (github.tokenProvider) return { tokenProvider: github.tokenProvider };
  return {
    appId: github.appId,
    installationId: github.installationId,
    privateKeyPem: github.privateKeyPem,
  };
}
