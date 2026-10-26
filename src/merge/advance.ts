import type { Database } from "bun:sqlite";
import { JOB_KIND } from "../core";
import {
  applyWorkItemEvent,
  artifactPublicationReady,
  closeoutPolicyDigest,
  completeMergedItem,
  enqueueJobOnce,
  getConfirmedRemoteMerge,
  getWorkItem,
  immediate,
  leaveMergeQueue,
  pendingChangeRequests,
  recordConfirmedRemoteMerge,
  recordRebaseReturn,
  wakePullReviews,
  type CiRound,
  type TaskMergeSettings,
  type WorkItemRecord,
} from "../db";
import {
  readPullFacts,
  rebaseOntoMain,
  squashPull,
  type GitExec,
  type GitHubBinding,
  type PullFacts,
  type SerialMergeInput,
} from "../github";
import { ciFixHandoff, ciFixQuestion, ciFixRoundLine } from "./ci-fix";
import type { MergeFacts } from "./mergeable";
import {
  REBASE_CONFLICT_INSTRUCTION,
  REBASE_CONFLICT_THOUGHT,
  askHelp,
  ciRound,
  mergeQueueTurn,
  mergeThroughGitHubQueue,
  sendBack,
  type MergeContext,
  type MergePull,
  type OrderCapabilities,
} from "./orders";
import type { RebaseConflict } from "./budget";
import { ciFixes, rebaseBudgetFor } from "./returns";
import {
  laneTurn,
  serialMergeStep,
  type LaneTurn,
  type MergeStep,
  type SerialMergeStep,
} from "./step";
import { wakeMergesBehind } from "./wait";

export type MergePublication = MergePull & {
  github: GitHubBinding & { gitExec: GitExec };
  worktree: string;
  branchKey: string;
  summary: string;
  commit: { title: string; message?: string; env?: Record<string, string> };
};

export type MergeCapabilities = OrderCapabilities & {
  publish(item: WorkItemRecord): Promise<MergePublication | MergeStep>;
  settings(item: WorkItemRecord, signal: AbortSignal): Promise<TaskMergeSettings>;
  /** Closeout's policy digest for the item's worktree now: `""` without a policy, null unreadable. */
  policyDigest(item: WorkItemRecord, worktree: string): string | null;
  assertReady(item: WorkItemRecord): Promise<void>;
  completed(): void;
};

/**
 * One merge lane turn for an item in `merge_queue`. The lane squashes head S only when
 * `mergeable(S)` holds, with GitHub's expected-head guard on S. A head behind main is rebased,
 * pushed and sent back to `verifying`, so Closeout accepts every head that merges.
 */
export async function advanceMerge(
  db: Database,
  input: { itemId: string; payload: unknown; jobId: number },
  caps: MergeCapabilities,
): Promise<MergeStep> {
  const item = getWorkItem(db, input.itemId);
  if (
    item === null ||
    item.state === "cancelled" ||
    item.state === "merged" ||
    item.state === "completed"
  )
    return { kind: "obsolete" };
  if (getConfirmedRemoteMerge(db, item.id)) {
    if (completeMergedItem(db, { itemId: item.id, now: caps.now() })) caps.completed();
    return { kind: "obsolete" };
  }
  if (pendingChangeRequests(db, item.id).length > 0) {
    // A changes-requested review restarts the item before any merge of this head.
    wakePullReviews(db, item.id, caps.now());
    return {
      kind: "wait",
      message: "Requested changes go back to the agent before this pull request merges.",
      queued: true,
      reason: "review",
    };
  }
  const published = await caps.publish(item);
  if ("kind" in published) return published;
  const merge: MergeContext = { db, item, caps };
  const { repository, github, pull } = published;
  const { voice } = caps;
  const mergeSettings = await caps.settings(item, published.signal);
  if (mergeSettings.order === "github-queue") {
    const handed = await mergeThroughGitHubQueue(merge, input.payload, published);
    if (handed !== "no_queue") return handed;
  }
  const queued = mergeSettings.order === "queue";
  if (queued) {
    const wait = await mergeQueueTurn(merge, repository, github, {
      number: pull.number,
      head: published.head,
    });
    if (wait) return { kind: "wait", ...wait };
    if (caps.stopped()) return { kind: "obsolete" };
  }
  const lane: SerialMergeInput = {
    worktree: published.worktree,
    issue: item.linearIdentifier,
    branchKey: published.branchKey,
    owner: repository.owner,
    repo: repository.repo,
    prNumber: pull.number,
    commitTitle: published.commit.title,
    commitMessage: published.commit.message,
    commitEnv: published.commit.env,
    appId: github.appId,
    installationId: github.installationId,
    privateKeyPem: github.privateKeyPem,
    client: github.client,
    gitExec: github.gitExec,
    ...(github.tokenProvider ? { tokenProvider: github.tokenProvider } : {}),
    remoteUrl: repository.remoteUrl,
    isCancelled: () => caps.stopped() || !artifactPublicationReady(db, item.id),
  };
  const turn = await laneTurn({
    read: () => readPullFacts(lane),
    facts: (facts) => mergeFacts(db, item.id, facts, caps.policyDigest(item, published.worktree)),
    rebase: () => rebaseOntoMain(lane),
    squash: (head, facts) => squashPull(lane, { head, base: facts.base }, published.summary),
  });
  const ciFixLimit = caps.ciFixAttempts(item);
  const result = turn.kind === "merged" || turn.kind === "stopped" ? turn.result : null;
  const conflict: RebaseConflict = {
    base: result?.base ?? null,
    files: result?.conflictFiles ?? null,
  };
  const { step, leaveQueue } = serialMergeStep({
    turn,
    queued,
    rebaseBudget: rebaseBudgetFor(db, item.id, conflict, caps.now()),
    ciFixes: ciFixes(db, item.id),
    ciFixLimit,
  });
  if (leaveQueue) {
    leaveMergeQueue(db, item.id);
    wakeMergesBehind(db, caps.now());
  }
  if (step.kind === "wait" && step.reason === "ci")
    return caps.stopped() ? { kind: "obsolete" } : step;
  if (turn.kind === "merged")
    recordConfirmedRemoteMerge(db, {
      itemId: item.id,
      repositoryOwner: repository.owner,
      repositoryName: repository.repo,
      pullNumber: pull.number,
      pullUrl: pull.url,
      mergeSha: turn.result.sha ?? null,
      confirmedAt: caps.now(),
    });
  if (caps.stopped()) {
    if (turn.kind === "merged") completeMergedItem(db, { itemId: item.id, now: caps.now() });
    return { kind: "obsolete" };
  }
  if (turn.kind === "merged") return { kind: "merged" };
  await caps.assertReady(item);
  if (getWorkItem(db, item.id)?.state === "awaiting_input") return { kind: "obsolete" };
  if (step.kind === "unreadable") throw new Error(step.message);
  if (step.kind === "reverify") {
    reverify(merge, step, input.jobId);
    if (step.rebased) await voice.flush();
    return { kind: "returned" };
  }
  if (step.kind === "wait") {
    voice.status(item, step.message, `${item.id}:merge-wait:${step.reason}:${step.head ?? ""}`);
    return step;
  }
  if (step.kind === "ask_conflict") {
    if (
      askHelp(
        merge,
        `${step.message} Reply with guidance to continue, or stop the task.`,
        "rebase_budget_spent",
      )
    ) {
      await voice.flush();
      return { kind: "asked" };
    }
    return { kind: "failed", reason: "merge", message: step.message };
  }
  if (
    step.kind === "return" &&
    step.reason === "rebase-conflict" &&
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
            candidate: result?.head ?? null,
            reason: "merge",
            ...conflict,
            recordedAt: caps.now(),
          }),
      },
    )
  )
    return { kind: "returned" };
  if (turn.kind === "blocked" && turn.block === "ci_failed") {
    const { readiness, head } = turn.pull;
    const checks = readiness.failedChecks ?? [];
    const round = (next: CiRound["next"], fix: number | null = null) =>
      ciRound(merge, head, readiness.checks, next, ciFixLimit, fix);
    if (
      step.kind === "return" &&
      sendBack(merge, "ci-failed", (fixes) => fixes < ciFixLimit, ciFixHandoff(checks), {
        thought: (attempt) => ciFixRoundLine(checks, attempt, ciFixLimit),
        record: (_, attempt) => round("agent", attempt),
      })
    )
      return { kind: "returned" };
    if (askHelp(merge, ciFixQuestion(checks, ciFixLimit, pull.url), "budget_spent")) {
      round("asked");
      await voice.flush();
      return { kind: "asked" };
    }
    round("failed");
  }
  const message = failure(turn, step);
  voice.thought(item, message, `${item.id}:merge:${result?.outcome ?? step.kind}`);
  return { kind: "failed", reason: "merge", message };
}

/** The facts `mergeable(S)` judges: GitHub's and Git's read, plus Closeout's accept row for S. */
function mergeFacts(
  db: Database,
  itemId: string,
  pull: PullFacts,
  policyDigest: string | null,
): MergeFacts {
  const acceptedHead = getWorkItem(db, itemId)?.acceptedHead ?? null;
  const { readiness } = pull;
  return {
    head: pull.head,
    headMoved: readiness.outcome === "sha_moved",
    accept:
      acceptedHead === null
        ? null
        : {
            head: acceptedHead,
            policyDigest: closeoutPolicyDigest(db, itemId, acceptedHead),
          },
    policyDigest,
    containsMain: pull.containsMain,
    ci:
      readiness.outcome === "ci_failed"
        ? "failed"
        : readiness.outcome === "ready" || readiness.unresolvedThreads !== undefined
          ? "green"
          : "pending",
    unresolvedThreads: readiness.unresolvedThreads ?? 0,
    protection:
      pull.review === "required"
        ? "review_required"
        : pull.review === "changes_requested"
          ? "changes_requested"
          : "satisfied",
  };
}

/**
 * Send the item back to `verifying` for Closeout on `head`, keeping its place in the queue. After
 * a rebase only the session title moves; the next merge job carries the accepted new head.
 */
function reverify(
  { db, item, caps }: MergeContext,
  step: Extract<SerialMergeStep, { kind: "reverify" }>,
  jobId: number,
): void {
  immediate(db, () => {
    applyWorkItemEvent(db, item.id, "reverify_requested");
    enqueueJobOnce(db, {
      queue: JOB_KIND.reverify,
      jobKey: `reverify:${item.id}:${step.head}:merge:${jobId}`,
      payload: { itemId: item.id },
      now: caps.now(),
    });
  });
  if (step.rebased)
    caps.voice.status(
      item,
      `Rebased onto main ${step.base.slice(0, 7)}, re-verifying.`,
      `${item.id}:rebased:${step.head}`,
    );
}

function failure(turn: LaneTurn, step: SerialMergeStep): string {
  if (step.kind === "failed") return step.message;
  if (turn.kind === "stopped") return turn.result.message ?? turn.result.outcome;
  if (turn.kind === "blocked" && turn.block === "ci_failed") return turn.pull.readiness.message;
  return step.kind;
}
