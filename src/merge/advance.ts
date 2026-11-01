import type { Database } from "bun:sqlite";
import { JOB_KIND } from "../core";
import {
  applyWorkItemEvent,
  beginMergeCall,
  carriedAcceptFor,
  closeoutPolicyDigests,
  completeMergedItem,
  endMergeCall,
  enqueueJobOnce,
  getConfirmedRemoteMerge,
  getWorkItem,
  immediate,
  leaveMergeQueue,
  mergeCallInFlight,
  recordCarriedAccept,
  recordConfirmedRemoteMerge,
  recordRebaseReturn,
  type CiRound,
  type ConfirmedRemoteMerge,
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
import { journal } from "../journal";
import { ciFixHandoff, ciFixQuestion, ciFixRoundLine } from "./ci-fix";
import type { MergeFacts, RiskApproval } from "./mergeable";
import {
  REBASE_CONFLICT_INSTRUCTION,
  REBASE_CONFLICT_THOUGHT,
  askHelp,
  ciRound,
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
import { mainMoved as checkQueueBehind } from "./queue-conflicts";
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
  /**
   * Closeout's policy digest for the item's worktree now, and the digest of its checks marked
   * `recheck: true`: `""` without a policy or such a check, null when the policy is unreadable.
   */
  policyDigests(item: WorkItemRecord, worktree: string): { digest: string; recheck: string } | null;
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
   * hand outside the lane. Null when there is none, it is not merged, or GitHub could not say.
   */
  mergedOutsideLane(
    item: WorkItemRecord,
  ): Promise<Omit<ConfirmedRemoteMerge, "itemId" | "confirmedAt"> | null>;
  completed(): void;
};

/**
 * One merge lane turn for an item in `merge_queue`. The lane squashes head S only when
 * `mergeable(S)` holds, with GitHub's expected-head guard on S. A head behind main is rebased and
 * pushed. With `[merge] main_moved = "closeout"` the new head goes back to `verifying`; with `ci`
 * and `overlap` it carries Closeout's acceptance of the head it was rebased from and merges once
 * its CI is green. `overlap` merges a head main's new commits do not touch without a rebase.
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
  // A pull request merged by hand on GitHub merges the item: publishing again would open another.
  const outside = await mergedOutsideLane(db, item, caps);
  if (outside) return outside;
  if (restartedDuringMergeCall(db, item.id, input.payload)) {
    reverifyAfterRestart(db, item, input.jobId, caps.now());
    return { kind: "returned" };
  }
  const held = reviewHold(db, item.id, caps.now());
  if (held) return held;
  const waiting = dependencyWait(item, caps);
  if (waiting) return waiting;
  const published = await caps.publish(item);
  if ("kind" in published) return published;
  const merge: MergeContext = { db, item, caps };
  // A high-risk head waits for a person in Paws before it joins any merge queue.
  const riskApproval = await caps.riskApproval(item, published);
  if (caps.stopped()) return { kind: "obsolete" };
  if (riskApproval === "missing") return holdForRisk(db, item, caps, published);
  const { repository, github, pull } = published;
  const { voice } = caps;
  const mergeSettings = await caps.settings(item, published.signal);
  if (mergeSettings.order === "github-queue") {
    const handed = await mergeThroughGitHubQueue(merge, input.payload, published);
    if (handed !== "no_queue") {
      if (handed.kind === "merged")
        checkQueueBehind(db, { repository: queueName(repository), main: null, now: caps.now() });
      return handed;
    }
  }
  const queued = mergeSettings.order === "queue";
  if (queued) {
    const wait = await mergeQueueTurn(merge, repository, github, {
      number: pull.number,
      head: published.head,
    });
    if (wait?.reason === "ahead" && recheckChanged(db, item, caps, published.worktree)) {
      // A change to a check marked `recheck: true` spent every waiting acceptance; each
      // re-verifies now, in parallel up to the free slots, and keeps its place instead of
      // waiting for its turn at the front.
      reverify(
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
  const turn = await laneTurn({
    read: () => readPullFacts(lane),
    facts: (facts) =>
      mergeFacts(
        db,
        item.id,
        facts,
        caps.policyDigests(item, published.worktree),
        mergeSettings.mainMoved,
        { head: published.head, approval: riskApproval },
      ),
    rebase: () => rebaseOntoMain(lane),
    squash: async (head, facts) => {
      // A call that throws may still have reached GitHub, so its marker stays for the next start.
      beginMergeCall(db, item.id, head, caps.now());
      const squashed = await squashPull(lane, { head, base: facts.base }, published.summary);
      if (!squashed.merged) endMergeCall(db, item.id);
      return squashed;
    },
  });
  // A review recorded during the turn stopped the squash or rebase; it goes to the agent first.
  // A turn that already rebased goes on to re-verify the pushed head.
  if ((turn.kind === "stopped" || turn.kind === "blocked") && !caps.stopped()) {
    const late = reviewHold(db, item.id, caps.now());
    if (late) return late;
  }
  const ciFixLimit = caps.ciFixAttempts(item);
  const result = turn.kind === "merged" || turn.kind === "stopped" ? turn.result : null;
  const conflict: RebaseConflict = {
    base: result?.base ?? null,
    files: result?.conflictFiles ?? null,
  };
  const { step, leaveQueue } = serialMergeStep({
    turn,
    queued,
    mainMoved: mergeSettings.mainMoved,
    rebaseBudget: rebaseBudgetFor(db, item.id, conflict, caps.now()),
    ciFixes: ciFixes(db, item.id),
    ciFixLimit,
  });
  if (leaveQueue) {
    leaveMergeQueue(db, item.id);
    wakeMergesBehind(db, caps.now());
  }
  // The pushed head carries the acceptance whatever happens to this turn next.
  const acceptedHead = getWorkItem(db, item.id)?.acceptedHead ?? null;
  if (step.kind === "carry" && acceptedHead !== null)
    recordCarriedAccept(db, {
      itemId: item.id,
      head: step.head,
      acceptedHead,
      base: step.base,
      now: caps.now(),
    });
  if (step.kind === "wait" && step.reason === "ci")
    return caps.stopped() ? { kind: "obsolete" } : step;
  if (turn.kind === "merged") {
    checkQueueBehind(db, {
      repository: queueName(repository),
      main: turn.result.sha ?? null,
      now: caps.now(),
    });
    recordConfirmedRemoteMerge(db, {
      itemId: item.id,
      repositoryOwner: repository.owner,
      repositoryName: repository.repo,
      pullNumber: pull.number,
      pullUrl: pull.url,
      mergeSha: turn.result.sha ?? null,
      confirmedAt: caps.now(),
    });
  }
  if (caps.stopped()) {
    if (turn.kind === "merged" && completeMergedItem(db, { itemId: item.id, now: caps.now() }))
      caps.completed();
    return { kind: "obsolete" };
  }
  if (turn.kind === "merged") return { kind: "merged" };
  await caps.assertReady(item);
  if (getWorkItem(db, item.id)?.state === "awaiting_input") return { kind: "obsolete" };
  if (step.kind === "unreadable") throw new Error(step.message);
  if (step.kind === "ask_risk") return holdForRisk(db, item, caps, published);
  if (step.kind === "reverify") {
    reverify(merge, step, input.jobId);
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
        failedChecks: checks,
        pullNumber: pull.number,
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
  // A person merged the pull request on GitHub during the turn, so the lane found it closed.
  const late = await mergedOutsideLane(db, item, caps);
  if (late) return late;
  const message = failure(turn, step);
  voice.thought(item, message, `${item.id}:merge:${result?.outcome ?? step.kind}`);
  return { kind: "failed", reason: "merge", message };
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
  db: Database,
  item: WorkItemRecord,
  caps: MergeCapabilities,
): Promise<MergeStep | null> {
  const merge = await caps.mergedOutsideLane(item);
  if (merge === null || getWorkItem(db, item.id)?.state !== "merge_queue") return null;
  recordConfirmedRemoteMerge(db, { ...merge, itemId: item.id, confirmedAt: caps.now() });
  leaveMergeQueue(db, item.id);
  wakeMergesBehind(db, caps.now());
  journal(
    `item ${item.linearIdentifier} merged outside the merge lane: #${merge.pullNumber} at ${merge.mergeSha ?? "unknown commit"}`,
  );
  if (caps.stopped()) {
    if (completeMergedItem(db, { itemId: item.id, now: caps.now() })) caps.completed();
    return { kind: "obsolete" };
  }
  return { kind: "merged" };
}

/** Paws stopped while the lane's merge call for the item may have been in flight. */
function restartedDuringMergeCall(db: Database, itemId: string, payload: unknown): boolean {
  const flagged =
    typeof payload === "object" &&
    payload !== null &&
    (payload as { mergeCallInFlight?: unknown }).mergeCallInFlight === true;
  return flagged && mergeCallInFlight(db, itemId);
}

/**
 * GitHub does not show the merge that may have been in flight when Paws stopped, so the merge
 * fails closed: Closeout checks the head again before the lane does, and the item keeps its place.
 */
function reverifyAfterRestart(
  db: Database,
  item: WorkItemRecord,
  jobId: number,
  now: number,
): void {
  immediate(db, () => {
    endMergeCall(db, item.id);
    applyWorkItemEvent(db, item.id, "reverify_requested");
    enqueueJobOnce(db, {
      queue: JOB_KIND.reverify,
      jobKey: `reverify:restart:${item.id}:${jobId}`,
      payload: { itemId: item.id },
      now,
    });
  });
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
function recheckChanged(
  db: Database,
  item: WorkItemRecord,
  caps: MergeCapabilities,
  worktree: string,
): boolean {
  const acceptedHead = getWorkItem(db, item.id)?.acceptedHead ?? null;
  if (acceptedHead === null) return false;
  const accepted = closeoutPolicyDigests(db, item.id, acceptedHead);
  if (accepted === null) return false;
  const current = caps.policyDigests(item, worktree);
  if (current === null || accepted.digest === current.digest) return false;
  return accepted.recheck !== current.recheck;
}

/**
 * The facts `mergeable(S)` judges: GitHub's and Git's read, plus Closeout's accept row for S.
 * Under `ci` and `overlap`, a head the lane rebased from the accepted head carries its row.
 */
function mergeFacts(
  db: Database,
  itemId: string,
  pull: PullFacts,
  policy: { digest: string; recheck: string } | null,
  mainMoved: TaskMergeSettings["mainMoved"],
  risk: { head: string; approval: RiskApproval },
): MergeFacts {
  const acceptedHead = getWorkItem(db, itemId)?.acceptedHead ?? null;
  const accepted = acceptedHead === null ? null : closeoutPolicyDigests(db, itemId, acceptedHead);
  const { readiness } = pull;
  const carried =
    mainMoved !== "closeout" &&
    acceptedHead !== null &&
    acceptedHead !== pull.head &&
    carriedAcceptFor(db, itemId, pull.head) === acceptedHead;
  return {
    head: pull.head,
    headMoved: readiness.outcome === "sha_moved",
    accept:
      acceptedHead === null
        ? null
        : {
            head: carried ? pull.head : acceptedHead,
            policyDigest: accepted?.digest ?? null,
            recheckDigest: accepted?.recheck ?? null,
          },
    policyDigest: policy?.digest ?? null,
    recheckDigest: policy?.recheck ?? null,
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
  db: Database,
  item: WorkItemRecord,
  caps: MergeCapabilities,
  published: MergePublication,
): Promise<MergeStep> {
  leaveMergeQueue(db, item.id);
  wakeMergesBehind(db, caps.now());
  return caps.askRiskApproval(item, published);
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
  // Busy now, it no longer holds the lane: the ready tasks behind it look again.
  wakeMergesBehind(db, caps.now());
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
