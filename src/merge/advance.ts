import type { Database } from "bun:sqlite";
import { JOB_KIND } from "../core";
import {
  applyWorkItemEventSteps,
  beginMergeCall,
  mergeStopRequestedSteps,
  carriedAcceptForSteps,
  closeoutPolicyDigestsSteps,
  completeMergedItemSteps,
  countMergeDenialsSteps,
  emitJobReady,
  endMergeCallSteps,
  enqueueJobOnceSteps,
  fixRoundsSteps,
  getConfirmedRemoteMergeSteps,
  getWorkItemSteps,
  hasCiRerunSteps,
  leaveMergeQueueSteps,
  MERGE_DENIED_REASON,
  mergeCallInFlightSteps,
  recordCarriedAcceptSteps,
  recordConfirmedRemoteMergeSteps,
  recordRebaseReturn,
  type CiRound,
  type ConfirmedRemoteMerge,
  type Db,
  type TaskMergeSettings,
  type WorkItemRecord,
  getItemCandidate,
  recordItemCandidateSteps,
  wakeMergesBehindSteps,
} from "../db";
import {
  adoptRunnerRebase,
  leaveGitHubMergeQueue,
  readPullFacts,
  rebaseOntoMain,
  squashPull,
  type GitExec,
  type GitHubBinding,
  type PullFacts,
  type RebaseResult,
  type SerialMergeInput,
} from "../github";
import { journal, journalCaught } from "../journal";
import { ciFixHandoff, ciFixQuestion, ciFixRoundLine } from "./ci-fix";
import { MERGE_DENIAL_LIMIT, RETRY_MERGE, mergeDeniedQuestion } from "./merge-denied";
import type { MergeFacts, RiskApproval } from "./mergeable";
import {
  collectCiFailure,
  REBASE_CONFLICT_INSTRUCTION,
  REBASE_CONFLICT_THOUGHT,
  askHelp,
  ciRound,
  ciRoundAsync,
  feedbackHold,
  mergeHeld,
  mergeQueueTurn,
  mergeThroughGitHubQueue,
  reviewHold,
  sendBack,
  type MergeContext,
  type MergePull,
  type OrderCapabilities,
} from "./orders";
import type { RebaseConflict } from "./budget";
import { mainMovedAsync as checkQueueBehind } from "./queue-conflicts";
import { rebaseBudgetFor, rebaseBudgetForSteps } from "./returns";
import {
  laneTurn,
  serialMergeStep,
  type LaneTurn,
  type MergeStep,
  type SerialMergeStep,
} from "./step";
import { githubQueueWatch } from "./wait";

export type MergePublication = MergePull & {
  github: GitHubBinding & { gitExec: GitExec };
  /** The item worktree, or the bare mirror of a runner-backed item. */
  worktree: string;
  /** The candidate ref that names the head in the mirror; `HEAD` of the worktree when unset. */
  ref?: string;
  branchKey: string;
  summary: string;
  commit: { title: string; message?: string; env?: Record<string, string> };
};

export type RunnerRebase =
  | { outcome: "rebased"; head: string }
  | { outcome: "conflict"; files: string[] }
  | { outcome: "failed"; reason: string };

export type MainPolicyUnreadable = {
  ok: false;
  message: string;
  path: string;
  main: string;
  commit: string | null;
};

export type MergeResultPolicyError = { error: string; reference: string };

export type PolicyRead = { digest: string; recheck: string } | MainPolicyUnreadable | null;

export type MergeCapabilities = OrderCapabilities & {
  runnerRebase?(
    item: WorkItemRecord,
    heads: { head: string; main: string },
    signal: AbortSignal,
  ): Promise<RunnerRebase>;
  publish(item: WorkItemRecord): Promise<MergePublication | MergeStep>;
  settings(item: WorkItemRecord, signal: AbortSignal): Promise<TaskMergeSettings>;
  /**
   * Closeout's policy digest for the item's worktree or mirror now, and the digest of its checks marked
   * `recheck: true`: `""` without a policy or such a check, null when the policy is unreadable.
   */
  policyDigests(item: WorkItemRecord, worktree: string): PolicyRead;
  holdForPolicy?(
    item: WorkItemRecord,
    repository: string,
    unreadable: MainPolicyUnreadable,
  ): string;
  policyLoads?(repository: string): void;
  mergeResultPolicy?(
    item: WorkItemRecord,
    worktree: string,
    heads: { base: string; head: string },
  ): MergeResultPolicyError | undefined;
  /** `[merge.repositories."owner/repo"] packages`, the package roots `overlap` compares by. */
  packages(repository: string): string[];
  assertReady(item: WorkItemRecord): Promise<void>;
  /** Whether head S needs, and has, a person's risk approval in Paws. */
  riskApproval(item: WorkItemRecord, published: MergePublication): Promise<RiskApproval>;
  /**
   * Asks for the risk approval of S on the item page. The item leaves the merge queue and waits
   * in `awaiting_input`. `asked`, or `failed` when Paws could not ask.
   */
  askRiskApproval(item: WorkItemRecord, published: MergePublication): Promise<MergeStep>;
  /**
   * The merge GitHub reports for the pull request Paws opened for the item, when it merged by
   * hand outside the lane. Null confirms it is unmerged or has no pull; `unknown` means
   * GitHub could not confirm either outcome.
   */
  mergedOutsideLane(
    item: WorkItemRecord,
  ): Promise<Omit<ConfirmedRemoteMerge, "itemId" | "confirmedAt"> | null | "unknown">;
  rerunCi?(item: WorkItemRecord, pullNumber: number, reason: string): Promise<string>;
  completed(): unknown;
};

const CANCELLED_CI_RERUN = "cancelled or timed-out CI job";

async function rerunCancelledCi(
  store: Db,
  item: WorkItemRecord,
  caps: MergeCapabilities,
  turn: LaneTurn,
  pullNumber: number,
): Promise<MergeStep | null> {
  if (turn.kind !== "blocked" || turn.block !== "ci_failed") return null;
  const { readiness, head, base } = turn.pull;
  if (
    !caps.rerunCi ||
    readiness.onlyCancelled !== true ||
    (await store.run((q) => hasCiRerunSteps(q, item.id, head)))
  )
    return null;
  await caps.rerunCi(item, pullNumber, CANCELLED_CI_RERUN).catch((error: unknown) => {
    journalCaught(error, "advance.rerunCancelledCi", item.id);
  });
  if (caps.stopped()) return { kind: "obsolete" };
  if (!(await store.run((q) => hasCiRerunSteps(q, item.id, head)))) return null;
  const message = `Re-ran cancelled CI jobs on ${head.slice(0, 7)}.`;
  caps.voice.status(item, message, `${item.id}:ci-rerun:${head}`);
  await caps.voice.flush();
  return { kind: "wait", reason: "ci", message, base, head };
}

/**
 * One merge lane turn for an item in `merge_queue`. The lane squashes head S only when
 * `mergeable(S)` holds, with GitHub's expected-head guard on S. A head behind main is rebased and
 * pushed. With `[merge] main_moved = "closeout"` the new head goes back to `verifying`; with `ci`
 * and `overlap` it carries Closeout's acceptance of the head it was rebased from and merges once
 * its CI is green. `overlap` merges a head main's new commits do not touch without a rebase.
 */
export async function advanceMerge(
  db: Database,
  store: Db,
  input: { itemId: string; payload: unknown; jobId: number },
  caps: MergeCapabilities,
): Promise<MergeStep> {
  const item = await store.run((q) => getWorkItemSteps(q, input.itemId));
  if (
    item === null ||
    item.state === "cancelled" ||
    item.state === "merged" ||
    item.state === "completed"
  )
    return { kind: "obsolete" };
  if (await store.run((q) => getConfirmedRemoteMergeSteps(q, item.id))) {
    await store.run((q) => endMergeCallSteps(q, item.id));
    await completeMerged(store, item, caps);
    return { kind: "obsolete" };
  }
  // A pull request merged by hand on GitHub merges the item: publishing again would open another.
  const outside = await mergedOutsideLane(store, item, caps);
  if (outside) return outside;
  if (await store.run((q) => mergeCallInFlightSteps(q, item.id))) {
    await reverifyAfterRestart(store, item, input.jobId, caps.now());
    return { kind: "returned" };
  }
  const merge: MergeContext = { db, store, item, caps };
  const held = await feedbackHold(merge, input.payload);
  if (held) return held;
  const waiting = dependencyWait(item, caps);
  if (waiting) return waiting;
  const published = await caps.publish(item);
  if ("kind" in published) return published;
  // A high-risk head waits for a person in Paws before it joins any merge queue.
  const riskApproval = await caps.riskApproval(item, published);
  if (caps.stopped()) return { kind: "obsolete" };
  if (riskApproval === "missing") return holdForRisk(store, item, caps, published);
  const { repository, github, pull } = published;
  const { voice } = caps;
  const mergeSettings = await caps.settings(item, published.signal);
  if (mergeSettings.order === "github-queue") {
    const refused = await githubQueuePolicy(merge, caps, published, input.payload);
    if (refused) return refused;
    const handed = await mergeThroughGitHubQueue(merge, input.payload, published);
    if (handed !== "no_queue") {
      if (handed.kind === "merged")
        await checkQueueBehind(store, {
          repository: queueName(repository),
          main: null,
          now: caps.now(),
        });
      return handed;
    }
  }
  const queued = mergeSettings.order === "queue";
  if (queued) {
    const wait = await mergeQueueTurn(merge, repository, github, {
      number: pull.number,
      url: pull.url,
      head: published.head,
    });
    if (wait && "kind" in wait) return wait;
    if (wait?.reason === "ahead" && (await recheckChanged(store, item, caps, published.worktree))) {
      // A change to a check marked `recheck: true` spent every waiting acceptance; each
      // re-verifies now, in parallel up to the free slots, and keeps its place instead of
      // waiting for its turn at the front.
      await reverify(
        merge,
        { kind: "reverify", head: published.head, base: "", rebased: false },
        input.jobId,
      );
      return { kind: "returned" };
    }
    if (wait) return { kind: "wait", ...wait };
    if (caps.stopped()) return { kind: "obsolete" };
  }
  const lane: SerialMergeInput = {
    publishedAt: (head) => {
      const candidate = getItemCandidate(db, item.id);
      return candidate?.sha === head ? candidate.recordedAt : null;
    },
    worktree: published.worktree,
    ...(published.ref ? { ref: published.ref } : {}),
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
    isCancelled: () => mergeHeld(merge),
    ...(mergeSettings.mainMoved === "overlap" || mergeSettings.mainMoved === "green"
      ? {
          overlap: {
            packages: caps.packages(`${repository.owner}/${repository.repo}`),
            anyFiles: mergeSettings.mainMoved === "green",
          },
        }
      : {}),
  };
  let mainPolicy: PolicyRead | undefined;
  let mergedPolicyError: MergeResultPolicyError | undefined;
  const turn = await laneTurn({
    read: () => readPullFacts(lane),
    facts: async (facts) => {
      facts.readiness = await collectCiFailure(merge, pull.number, facts.head, facts.readiness);
      mainPolicy = caps.policyDigests(item, published.worktree);
      return mergeFacts(store, item.id, facts, mainPolicy, mergeSettings.mainMoved, {
        head: published.head,
        approval: riskApproval,
      });
    },
    rebase: async (facts) => {
      const rebased = await rebaseOnRunner(item, caps, lane, facts, published.signal);
      if (rebased.rebased)
        await store.run((q) =>
          recordItemCandidateSteps(q, {
            itemId: item.id,
            sha: rebased.head,
            branch: rebased.branch,
            recordedAt: caps.now(),
          }),
        );

      return rebased;
    },
    squash: async (head, facts) => {
      mergedPolicyError = caps.mergeResultPolicy?.(item, published.worktree, {
        base: facts.base,
        head,
      });
      if (mergedPolicyError !== undefined)
        return {
          merged: false,
          outcome: "invalid",
          branch: facts.branch,
          base: facts.base,
          head,
          message: mergedPolicyMessage(mergedPolicyError.error),
        };
      const squashed = await squashPull(
        {
          ...lane,
          beforeMergeCall: (expectedHead) => beginMergeCall(db, item.id, expectedHead, caps.now()),
        },
        { head, base: facts.base },
        published.summary,
      );
      if (!squashed.merged && squashed.outcome !== "unknown")
        await store.run((q) => endMergeCallSteps(q, item.id));
      return squashed;
    },
  });
  if (mainPolicy && !("ok" in mainPolicy)) caps.policyLoads?.(queueName(repository));
  if (turn.kind === "stopped" && turn.result.outcome === "unknown") return pendingMergeOutcome();
  // A review recorded during the turn stopped the squash or rebase; it goes to the agent first.
  // A turn that already rebased goes on to re-verify the pushed head.
  if ((turn.kind === "stopped" || turn.kind === "blocked") && !caps.stopped()) {
    const late = await reviewHold(store, item.id, caps.now(), caps.feedbackWait());
    if (late) return late;
  }
  const rerun = await rerunCancelledCi(store, item, caps, turn, pull.number);
  if (rerun) return rerun;
  const ciFixLimit = caps.ciFixAttempts(item);
  const result = turn.kind === "merged" || turn.kind === "stopped" ? turn.result : null;
  const conflict: RebaseConflict = {
    base: result?.base ?? null,
    files: result?.conflictFiles ?? null,
  };
  const rebaseBudget = await store.run((q) =>
    rebaseBudgetForSteps(q, item.id, conflict, caps.now()),
  );
  const ciFixes = await store.run((q) => fixRoundsSteps(q, item.id));
  const { step, leaveQueue } = serialMergeStep({
    turn,
    queued,
    mainMoved: mergeSettings.mainMoved,
    rebaseBudget,
    ciFixes,
    ciFixLimit,
  });
  if (leaveQueue) {
    await store.run((q) => leaveMergeQueueSteps(q, item.id));
    await store.run((q) => wakeMergesBehindSteps(q, caps.now()));
  }
  // The pushed head carries the acceptance whatever happens to this turn next.
  const acceptedHead = (await store.run((q) => getWorkItemSteps(q, item.id)))?.acceptedHead ?? null;
  if (step.kind === "carry" && acceptedHead !== null)
    await store.run((q) =>
      recordCarriedAcceptSteps(q, {
        itemId: item.id,
        head: step.head,
        acceptedHead,
        base: step.base,
        now: caps.now(),
      }),
    );
  if (step.kind === "wait" && step.reason === "ci")
    return caps.stopped() ? { kind: "obsolete" } : step;
  if (turn.kind === "merged") {
    await checkQueueBehind(store, {
      repository: queueName(repository),
      main: turn.result.sha ?? null,
      now: caps.now(),
    });
    await store.transaction((q) =>
      recordConfirmedRemoteMergeSteps(q, {
        itemId: item.id,
        repositoryOwner: repository.owner,
        repositoryName: repository.repo,
        pullNumber: pull.number,
        pullUrl: pull.url,
        mergeSha: turn.result.sha ?? null,
        confirmedAt: caps.now(),
      }),
    );
  }
  // A deferred stop owns the next step after an unsent or unsuccessful squash.
  if (turn.kind !== "merged" && (await store.run((q) => mergeStopRequestedSteps(q, item.id))))
    return { kind: "obsolete" };
  if (caps.stopped()) {
    if (turn.kind === "merged") await completeMerged(store, item, caps);
    return { kind: "obsolete" };
  }
  if (turn.kind === "merged") return { kind: "merged" };
  await caps.assertReady(item);
  if ((await store.run((q) => getWorkItemSteps(q, item.id)))?.state === "awaiting_input")
    return { kind: "obsolete" };
  if (step.kind === "unreadable") throw new Error(step.message);
  if (mergedPolicyError !== undefined) return returnForPolicy(merge, mergedPolicyError, ciFixLimit);
  if (step.kind === "hold_policy" && mainPolicy && "ok" in mainPolicy)
    return holdForMainPolicy(item, caps, queueName(repository), mainPolicy, {
      base: step.base,
      head: step.head,
    });
  if (step.kind === "ask_risk") return holdForRisk(store, item, caps, published);
  if (step.kind === "reverify") {
    await reverify(merge, step, input.jobId);
    if (step.rebased) await voice.flush();
    return { kind: "returned" };
  }
  if (step.kind === "carry") {
    voice.status(item, step.message, `${item.id}:branch-updated:${step.head}`);
    await voice.flush();
    return { kind: "wait", reason: "ci", message: step.message, base: step.base, head: step.head };
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
        conflict: { pullNumber: pull.number, head: result?.head ?? published.head },
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
      sendBack(
        merge,
        "ci-failed",
        (fixes) => fixes < ciFixLimit,
        ciFixHandoff(checks, readiness.waitingChecks),
        {
          thought: (attempt) => ciFixRoundLine(checks, attempt, ciFixLimit),
          record: (_, attempt) => round("agent", attempt),
          failedChecks: checks,
          pullNumber: pull.number,
        },
      )
    )
      return { kind: "returned" };
    if (askHelp(merge, ciFixQuestion(checks, ciFixLimit, pull.url), "budget_spent")) {
      await ciRoundAsync(merge, head, readiness.checks, "asked", ciFixLimit, null);
      await voice.flush();
      return { kind: "asked" };
    }
    await ciRoundAsync(merge, head, readiness.checks, "failed", ciFixLimit, null);
  }
  // A person merged the pull request on GitHub during the turn, so the lane found it closed.
  const late = await mergedOutsideLane(store, item, caps);
  if (late) return late;
  const denials = (head: string) => store.run((q) => countMergeDenialsSteps(q, item.id, head));
  if (
    result?.outcome === "merge_denied" &&
    result.status !== undefined &&
    result.status !== 401 &&
    result.status !== 403 &&
    result.head !== undefined &&
    (await denials(result.head)) + 1 < MERGE_DENIAL_LIMIT &&
    askHelp(
      merge,
      mergeDeniedQuestion({
        status: result.status,
        reason: result.reason,
        head: result.head,
        pullUrl: pull.url,
      }),
      MERGE_DENIED_REASON,
      [RETRY_MERGE],
    )
  ) {
    await voice.flush();
    return { kind: "asked" };
  }
  const message = failure(turn, step);
  voice.thought(item, message, `${item.id}:merge:${result?.outcome ?? step.kind}`);
  return { kind: "failed", reason: "merge", message };
}

async function githubQueuePolicy(
  merge: MergeContext,
  caps: MergeCapabilities,
  published: MergePublication,
  payload: unknown,
): Promise<MergeStep | undefined> {
  const { item } = merge;
  if (!caps.mergeResultPolicy) return undefined;
  const watch = githubQueueWatch(payload);
  let main: string | null;
  try {
    main = await caps.fetchMain(item);
  } catch (error) {
    journalCaught(error, "advance.githubQueuePolicy", item.id);
    return {
      kind: "wait",
      reason: "ci",
      message: "Could not read main to check the merge result's Closeout policy. Trying again.",
      head: published.head,
      ...(watch ? { githubQueue: watch } : {}),
    };
  }
  if (caps.stopped()) return { kind: "obsolete" };
  if (main === null) return undefined;
  const repository = queueName(published.repository);
  const mainPolicy = caps.policyDigests(item, published.worktree);
  if (mainPolicy && "ok" in mainPolicy) {
    if (watch?.queued && (await leaveGitHubQueue(published)) === "merged") return undefined;
    return {
      ...holdForMainPolicy(item, caps, repository, mainPolicy, { head: published.head }),
      githubQueue: { queued: false },
    };
  }
  if (mainPolicy) caps.policyLoads?.(repository);
  const broken = caps.mergeResultPolicy(item, published.worktree, {
    base: main,
    head: published.head,
  });
  if (!broken) return undefined;
  if (watch?.queued && (await leaveGitHubQueue(published)) === "merged") return undefined;
  return returnForPolicy(merge, broken, caps.ciFixAttempts(item));
}

function leaveGitHubQueue(published: MergePublication) {
  const { github, repository, pull } = published;
  return leaveGitHubMergeQueue({
    client: github.client,
    owner: repository.owner,
    repo: repository.repo,
    prNumber: pull.number,
    appId: github.appId,
    installationId: github.installationId,
    privateKeyPem: github.privateKeyPem,
    ...(github.tokenProvider ? { tokenProvider: github.tokenProvider } : {}),
    signal: published.signal,
  });
}

function holdForMainPolicy(
  item: WorkItemRecord,
  caps: MergeCapabilities,
  repository: string,
  unreadable: MainPolicyUnreadable,
  candidate: { base?: string; head: string },
): Extract<MergeStep, { kind: "wait" }> {
  const message =
    caps.holdForPolicy?.(item, repository, unreadable) ??
    `The Closeout policy on main doesn't load: ${unreadable.message}. Paws merges again once it's fixed.`;
  caps.voice.status(item, message, `${item.id}:policy-unreadable:${message}`);
  return { kind: "wait", reason: "policy", queued: true, message, ...candidate };
}

function mergedPolicyMessage(error: string): string {
  return `The Closeout policy doesn't load once this pull request merges into main: ${error}`;
}

async function returnForPolicy(
  merge: MergeContext,
  { error, reference }: MergeResultPolicyError,
  limit: number,
): Promise<MergeStep> {
  const message = mergedPolicyMessage(error);
  const handoff = `${message}. Paws did not merge it. Update the branch onto origin/main and fix .agents/closeout.yaml or the files it references so the policy loads on top of main.\n\n${reference}`;
  if (
    sendBack(merge, "policy-invalid", (fixes) => fixes < limit, handoff, {
      thought: () => `${message}. Sent it back to the agent.`,
      record: () => {},
    })
  ) {
    await merge.caps.voice.flush();
    return { kind: "returned" };
  }
  if (askHelp(merge, `${message}. Reply with guidance to continue, or stop the task.`)) {
    await merge.caps.voice.flush();
    return { kind: "asked" };
  }
  return { kind: "failed", reason: "merge", message };
}

async function rebaseOnRunner(
  item: WorkItemRecord,
  caps: MergeCapabilities,
  lane: SerialMergeInput,
  pull: PullFacts,
  signal: AbortSignal,
): Promise<RebaseResult> {
  const asked: RunnerRebase = caps.runnerRebase
    ? await caps
        .runnerRebase(item, { head: pull.head, main: pull.base }, signal)
        .catch((error: unknown) => {
          if (signal.aborted) throw error;
          return {
            outcome: "failed" as const,
            reason: error instanceof Error ? error.message : String(error),
          };
        })
    : { outcome: "failed", reason: "no runner rebase" };
  signal.throwIfAborted();
  if (asked.outcome === "conflict")
    return {
      rebased: false,
      result: {
        merged: false,
        outcome: "conflict",
        branch: pull.branch,
        base: pull.base,
        message: "rebase conflict",
        ...(asked.files.length > 0 ? { conflictFiles: asked.files } : {}),
      },
    };
  let reason = asked.outcome === "failed" ? asked.reason : "";
  if (asked.outcome === "rebased") {
    const adopted = await adoptRunnerRebase(
      lane,
      {
        head: pull.head,
        base: pull.base,
        rebased: asked.head,
      },
      signal,
    ).catch((error: unknown) => {
      if (signal.aborted) throw error;
      return { refused: error instanceof Error ? error.message : String(error) };
    });
    if (!("refused" in adopted)) return adopted;
    reason = `refused ${asked.head.slice(0, 7)}: ${adopted.refused}`;
  }
  journal(`item ${item.linearIdentifier} rebases on the control plane: runner rebase ${reason}`);
  return rebaseOntoMain(lane);
}

/** The repository as the merge queue names it. */
function queueName(repository: { owner: string; repo: string }): string {
  return `${repository.owner}/${repository.repo}`;
}

/**
 * Records the merge of a pull request merged outside the lane, and takes the item out of the
 * queue. The `merged` step completes it like a lane merge, which cancels its queued merge jobs.
 */
async function mergedOutsideLane(
  store: Db,
  item: WorkItemRecord,
  caps: MergeCapabilities,
): Promise<MergeStep | null> {
  const merge = await caps.mergedOutsideLane(item);
  if (merge === "unknown")
    return (await store.run((q) => mergeCallInFlightSteps(q, item.id)))
      ? pendingMergeOutcome()
      : null;
  if (merge === null) return null;
  const current = await store.run((q) => getWorkItemSteps(q, item.id));
  if (current?.state !== "merge_queue") return null;
  await store.transaction((q) =>
    recordConfirmedRemoteMergeSteps(q, { ...merge, itemId: item.id, confirmedAt: caps.now() }),
  );
  await store.run((q) => leaveMergeQueueSteps(q, item.id));
  await store.run((q) => wakeMergesBehindSteps(q, caps.now()));
  journal(
    `item ${item.linearIdentifier} merged outside the merge lane: #${merge.pullNumber} at ${merge.mergeSha ?? "unknown commit"}`,
  );
  if (caps.stopped()) {
    await completeMerged(store, item, caps);
    return { kind: "obsolete" };
  }
  return { kind: "merged" };
}

async function completeMerged(
  store: Db,
  item: WorkItemRecord,
  caps: MergeCapabilities,
): Promise<void> {
  const completed = await store.transaction((q) =>
    completeMergedItemSteps(q, { itemId: item.id, now: caps.now() }),
  );
  if (completed) await caps.completed();
}

/** Unknown remote outcomes wait without spending the CI deadline or leaving the queue. */
function pendingMergeOutcome(): MergeStep {
  return {
    kind: "wait",
    reason: "merge_outcome",
    message: "Waiting for GitHub to confirm the previous merge outcome.",
  };
}

/**
 * GitHub does not show the merge that may have been in flight when Paws stopped, so the merge
 * fails closed: Closeout checks the head again before the lane does, and the item keeps its place.
 */
async function reverifyAfterRestart(
  store: Db,
  item: WorkItemRecord,
  jobId: number,
  now: number,
): Promise<void> {
  const job = await store.transaction(function* (q) {
    yield* endMergeCallSteps(q, item.id);
    yield* applyWorkItemEventSteps(q, item.id, "reverify_requested");
    return yield* enqueueJobOnceSteps(q, {
      queue: JOB_KIND.reverify,
      jobKey: `reverify:restart:${item.id}:${jobId}`,
      payload: { itemId: item.id },
      now,
    });
  });
  if (job.inserted) emitJobReady(store);
  journal(`item ${item.linearIdentifier} re-verifies: its merge call may have been in flight`);
}

/**
 * A task whose Linear dependencies have not merged makes no lane attempt: it neither publishes nor
 * takes a place in the queue, so the blocker queued behind it merges first. Its merge job parks
 * without a deadline and wakes when a task merges.
 */
function dependencyWait(item: WorkItemRecord, caps: MergeCapabilities): MergeStep | null {
  const blockers = caps.dependencyHold(item.id);
  if (blockers === null) return null;
  const what = blockers.length ? blockers.join(", ") : "a blocking issue";
  const message = `${item.linearIdentifier}: waiting for ${what}`;
  caps.voice.status(item, message, `${item.id}:merge-dependencies:${what}`);
  return { kind: "wait", message, queued: true, reason: "dependencies" };
}

/**
 * Closeout accepted the item under a policy that differs from the readable one now in a check
 * marked `recheck: true`, or under a run that did not record those checks. A change to any other
 * check leaves the acceptance standing.
 */
async function recheckChanged(
  store: Db,
  item: WorkItemRecord,
  caps: MergeCapabilities,
  worktree: string,
): Promise<boolean> {
  const acceptedHead = (await store.run((q) => getWorkItemSteps(q, item.id)))?.acceptedHead ?? null;
  if (acceptedHead === null) return false;
  const accepted = await store.run((q) => closeoutPolicyDigestsSteps(q, item.id, acceptedHead));
  if (accepted === null) return false;
  const current = caps.policyDigests(item, worktree);
  if (current === null || "ok" in current || accepted.digest === current.digest) return false;
  return accepted.recheck !== current.recheck;
}

/**
 * The facts `mergeable(S)` judges: GitHub's and Git's read, plus Closeout's accept row for S.
 * Under `ci` and `overlap`, a head the lane rebased from the accepted head carries its row.
 */
async function mergeFacts(
  store: Db,
  itemId: string,
  pull: PullFacts,
  read: PolicyRead,
  mainMoved: TaskMergeSettings["mainMoved"],
  risk: { head: string; approval: RiskApproval },
): Promise<MergeFacts> {
  const policy = read !== null && !("ok" in read) ? read : null;
  const acceptedHead = (await store.run((q) => getWorkItemSteps(q, itemId)))?.acceptedHead ?? null;
  const accepted =
    acceptedHead === null
      ? null
      : await store.run((q) => closeoutPolicyDigestsSteps(q, itemId, acceptedHead));
  const { readiness } = pull;
  const carried =
    mainMoved !== "closeout" &&
    acceptedHead !== null &&
    acceptedHead !== pull.head &&
    (await store.run((q) => carriedAcceptForSteps(q, itemId, pull.head))) === acceptedHead;
  const headVerdict = carried
    ? await store.run((q) => closeoutPolicyDigestsSteps(q, itemId, pull.head))
    : null;
  return {
    head: pull.head,
    headMoved: readiness.outcome === "sha_moved",
    accept:
      acceptedHead === null ||
      (accepted !== null && accepted.decision !== "accepted") ||
      (headVerdict !== null && headVerdict.decision !== "accepted")
        ? null
        : {
            head: carried ? pull.head : acceptedHead,
            policyDigest: accepted?.digest ?? null,
            recheckDigest: accepted?.recheck ?? null,
          },
    policyDigest: policy?.digest ?? null,
    recheckDigest: policy?.recheck ?? null,
    ...(read !== null && "ok" in read ? { policyUnreadable: read.message } : {}),
    containsMain: pull.containsMain,
    ...(pull.apart === undefined ? {} : { apart: pull.apart }),
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
    // The approval was read for the published head. A head the lane rebased from it onto main
    // is the same patch on a newer main, so it keeps the approval; any other head has none yet.
    riskApproval:
      pull.head === risk.head || (carried && risk.head === acceptedHead)
        ? risk.approval
        : "missing",
  };
}

/** Takes the item out of the merge queue and asks for the risk approval of S. */
async function holdForRisk(
  store: Db,
  item: WorkItemRecord,
  caps: MergeCapabilities,
  published: MergePublication,
): Promise<MergeStep> {
  await store.run((q) => leaveMergeQueueSteps(q, item.id));
  await store.run((q) => wakeMergesBehindSteps(q, caps.now()));
  return caps.askRiskApproval(item, published);
}

/**
 * Send the item back to `verifying` for Closeout on `head`, keeping its place in the queue. After
 * a rebase only the session title moves; the next merge job carries the accepted new head.
 */
async function reverify(
  { store, item, caps }: MergeContext,
  step: Extract<SerialMergeStep, { kind: "reverify" }>,
  jobId: number,
): Promise<void> {
  const job = await store.transaction(function* (q) {
    yield* applyWorkItemEventSteps(q, item.id, "reverify_requested");
    return yield* enqueueJobOnceSteps(q, {
      queue: JOB_KIND.reverify,
      jobKey: `reverify:${item.id}:${step.head}:merge:${jobId}`,
      payload: { itemId: item.id },
      now: caps.now(),
    });
  });
  if (job.inserted) emitJobReady(store);
  // Busy now, it no longer holds the lane: the ready tasks behind it look again.
  await store.run((q) => wakeMergesBehindSteps(q, caps.now()));
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
