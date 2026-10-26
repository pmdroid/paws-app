import { journalCaught } from "../journal";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isTransient, isTransientGitError } from "../core";
import { applyBypasses, bypassSummary, type CloseoutBypass } from "./bypass";
import type { FixRequest, FixRunner } from "./fixer";
import { appendDecisionHistory, writeVerdictReport, type VerdictRecorder } from "./report";
import type { CodexReviewer } from "./reviewer";
import { formatEvidenceSummary, formatFixFeedback } from "./summary";
import {
  CLOSEOUT_GATE,
  MAX_FIX_ATTEMPTS,
  type CandidateIdentity,
  type CloseoutItem,
  type DecisionDocument,
  type GateOutcome,
  type GateResult,
  type ReviewFindings,
} from "./types";
import { isSha, readHead } from "./worktree";
import {
  addReview,
  credentialSecrets,
  policyFixBudget,
  preExistingFindings,
  loadReviewMaterial,
  renderReviewPrompt,
  retryBaseline as readRetryBaseline,
  reviewRequirements,
  decision as decide,
  run,
  scrubText,
  type CloseoutProgress,
  type PawsCommandRunner,
  type CloseoutProgressIdentity,
  type CloseoutProgressStep,
  type CloseoutStepState,
  type DecisionDocument as SpecDecision,
  type EvidenceApproval,
  type PublishedEvidence,
} from "../closeout-spec";

export type EvaluateInput = {
  checkoutExclusions?: readonly string[];
  worktree: string;
  taskId: string;
  base: string;
  head: string;
  candidate: CandidateIdentity;
  reviewer: CodexReviewer;
  /** Home for `~/.agents/closeout.yaml` when origin/main has no entry. */
  home?: string;
  policyRoot?: string;
  /** `~/.paws` for the detached command worktree. */
  pawsHome?: string;
  progress?: CloseoutProgress;
  commandRunner?: Pick<PawsCommandRunner, "runLogged">;
  retryBaseline?: readonly string[];
  bypasses?: readonly CloseoutBypass[];
  reviewRetryDelaysMs?: readonly number[];
  /** The task's videos and screenshots, read again for each evaluation. */
  published?: () => readonly PublishedEvidence[];
  /** Visual reviews of those files, read again for each evaluation. */
  approvals?: () => readonly EvidenceApproval[];
};

export type Evaluation = {
  outcome: "accepted" | "rejected" | "exhausted" | "blocked" | "invalid";
  exitCode: number | null;
  decision: DecisionDocument | null;
  error?: string;
  reviewFindings: ReviewFindings[];
  head: string;
  bypasses?: readonly CloseoutBypass[];
};

export type GateInput = {
  checkoutExclusions?: readonly string[];
  worktree: string;
  taskId: string;
  /** The Linear identifier the summary names, such as `PAS-367`. Defaults to `taskId`. */
  taskLabel?: string;
  base: string;
  /** Defaults to `git rev-parse HEAD` in the worktree. */
  head?: string;
  candidate: CandidateIdentity;
  reviewer: CodexReviewer;
  fixer: FixRunner;
  recorder?: VerdictRecorder;
  reportDir?: string;
  home?: string;
  policyRoot?: string;
  pawsHome?: string;
  maxFixAttempts?: number;
  progress?: CloseoutProgress;
  commandRunner?: Pick<PawsCommandRunner, "runLogged">;
  retryBaseline?: readonly string[];
  bypasses?: readonly CloseoutBypass[];
  reviewRetryDelaysMs?: readonly number[];
  published?: () => readonly PublishedEvidence[];
  approvals?: () => readonly EvidenceApproval[];
};

/**
 * One Closeout evaluation: native `run`, then Codex review evidence for any
 * review item that is missing or stale, then native `decision`.
 * Does not ask the implementer to fix anything.
 * Task id is the work item id.
 */
const liveIdentity = new WeakMap<CloseoutProgress, CloseoutProgressIdentity>();

type RunningSteps = Map<string, { identity: CloseoutProgressIdentity; step: CloseoutProgressStep }>;

export async function evaluateCandidate(input: EvaluateInput): Promise<Evaluation> {
  if (input.progress) liveIdentity.delete(input.progress);
  const running: RunningSteps = new Map();
  let native: Evaluation;
  try {
    native = await evaluateUnsealed(
      input.progress === undefined
        ? input
        : { ...input, progress: observe(input.progress, running) },
    );
  } catch (error) {
    const retrying = isTransient(error);
    stopRunning(input.progress, running, error, retrying);
    seal(input.progress, retrying ? "running" : "blocked");
    throw error;
  }
  const evaluation = applyBypasses(native, input.bypasses ?? []);
  seal(input.progress, evaluation.outcome);
  return evaluation;
}

function stopRunning(
  progress: CloseoutProgress | undefined,
  running: RunningSteps,
  error: unknown,
  retrying: boolean,
): void {
  if (progress === undefined) return;
  const message = scrub(error instanceof Error ? error.message : String(error));
  for (const { identity, step } of running.values()) {
    progress.step(
      identity,
      retrying
        ? { ...step, state: "pending", detail: `Retrying: ${message}` }
        : { ...step, state: "blocked", detail: `Stopped: ${message}`, finishedAt: Date.now() },
    );
  }
}

function observe(progress: CloseoutProgress, running: RunningSteps): CloseoutProgress {
  const secrets = credentialSecrets();
  const text = (value: string): string => scrubText(value, secrets);
  const optional = (value: string | null): string | null => (value === null ? null : text(value));
  return {
    begin(identity) {
      liveIdentity.set(progress, identity);
      progress.begin(identity);
    },
    step(identity, step) {
      liveIdentity.set(progress, identity);
      const scrubbed = {
        ...step,
        command: text(step.command),
        detail: optional(step.detail),
        timeoutReason: optional(step.timeoutReason),
        findings: optional(step.findings),
      };
      if (scrubbed.state === "running") running.set(step.id, { identity, step: scrubbed });
      else running.delete(step.id);
      progress.step(identity, scrubbed);
    },
    output(identity, stepId, stream, chunk, truncated) {
      progress.output(identity, stepId, stream, text(chunk), truncated);
    },
    finish(identity, decision) {
      liveIdentity.set(progress, identity);
      progress.finish(identity, decision);
    },
  };
}

function seal(progress: CloseoutProgress | undefined, decision: string): void {
  if (progress === undefined) return;
  const identity = liveIdentity.get(progress);
  if (identity === undefined) return;
  progress.finish(identity, decision);
}

async function evaluateUnsealed(input: EvaluateInput): Promise<Evaluation> {
  const taskError = assertTaskId(input.taskId);
  if (taskError) return failure("invalid", null, taskError, input.head);
  if (!isSha(input.base) || !isSha(input.head)) {
    return failure("invalid", null, "base and head must be commit ids", input.head);
  }

  const evidenceDir = evidencePath(input.taskId, input.pawsHome);
  const reviewFindings: ReviewFindings[] = [];
  const reviewAttempts = new Map<string, number>();
  const metrics: ReviewMetrics = new Map();
  const early = await startParallelReviews(
    input,
    evidenceDir,
    reviewFindings,
    reviewAttempts,
    metrics,
  );
  const progress =
    early && input.progress ? withoutReviewPlan(input.progress, early.gaps) : input.progress;
  let ran: SpecDecision;
  try {
    ran = await run({
      checkoutExclusions: input.checkoutExclusions,
      repo: input.worktree,
      base: input.base,
      head: input.head,
      gate: CLOSEOUT_GATE,
      task: input.taskId,
      candidate: input.candidate,
      evidenceDir,
      ...(input.home !== undefined ? { home: input.home } : {}),
      ...(input.policyRoot !== undefined ? { policyRoot: input.policyRoot } : {}),
      ...(input.retryBaseline !== undefined ? { retryBaseline: input.retryBaseline } : {}),
      ...publishedOf(input),
      ...(input.pawsHome !== undefined ? { pawsHome: input.pawsHome } : {}),
      ...(progress !== undefined ? { progress } : {}),
      ...(input.commandRunner ? { commandRunner: input.commandRunner } : {}),
    });
  } catch (error) {
    await early?.done.catch((caughtError1) => {
      journalCaught(caughtError1, "run.evaluateUnsealed", input.taskId);
      return null;
    });
    if (isTransient(error)) throw error;
    journalCaught(error, "run.evaluateUnsealed.run", input.taskId);
    const message = error instanceof Error ? error.message : String(error);
    return failure("blocked", null, message, input.head);
  }
  const filledEarly = await early?.done;
  if (filledEarly) return filledEarly;
  const unreadable = ran.message;
  if (
    ran.decision === "blocked" &&
    ran.items.length === 0 &&
    unreadable?.startsWith("origin/main is unavailable") &&
    isTransientGitError(unreadable)
  )
    throw new PolicyFetchError(unreadable);
  const moved = await headUnmoved(input.worktree, input.head);
  if (moved) return failure("blocked", exitOf(ran.decision), moved, input.head);
  if (ran.gate !== CLOSEOUT_GATE) {
    return failure("invalid", exitOf(ran.decision), "decision gate is not beforePR", input.head);
  }

  const first = toGateDecision(ran);
  const reviewed = early?.gaps ?? [];
  const gaps = reviewGaps(first).filter((item) => !reviewed.some((entry) => entry.id === item.id));
  if (
    (gaps.length === 0 && reviewed.length === 0) ||
    gaps.some((item) => first.items.find((entry) => entry.id === item.id)?.state === "exhausted")
  ) {
    publishReviews(input, first, reviewFindings, reviewAttempts, metrics);
    return finish(first, input.base, input.head, reviewFindings);
  }

  const filled =
    gaps.length === 0
      ? null
      : await addReviewEvidence(
          input,
          gaps,
          reviewFindings,
          reviewAttempts,
          metrics,
          evidenceDir,
          progressIdentity(input.taskId, first),
        );
  if (filled) return filled;

  let judged: SpecDecision;
  try {
    judged = await decide({
      checkoutExclusions: input.checkoutExclusions,
      repo: input.worktree,
      base: input.base,
      head: input.head,
      gate: CLOSEOUT_GATE,
      task: input.taskId,
      candidate: input.candidate,
      evidenceDir,
      ...(input.home !== undefined ? { home: input.home } : {}),
      ...(input.policyRoot !== undefined ? { policyRoot: input.policyRoot } : {}),
      ...(input.retryBaseline !== undefined ? { retryBaseline: input.retryBaseline } : {}),
      ...publishedOf(input),
    });
  } catch (error) {
    journalCaught(error, "run.evaluateUnsealed.decide", input.taskId);
    const message = error instanceof Error ? error.message : String(error);
    const detail = scrub(message);
    for (const item of [...reviewed, ...gaps]) {
      const found = reviewFindings.find((entry) => entry.itemId === item.id);
      noteReview(
        input,
        progressIdentity(input.taskId, first),
        item.id,
        "blocked",
        detail,
        found ? findingText(found) : null,
        item.attempt ?? reviewAttempts.get(item.id) ?? null,
        null,
        metrics.get(item.id),
      );
    }
    return failure("blocked", null, detail, input.head);
  }
  const movedAfter = await headUnmoved(input.worktree, input.head);
  if (movedAfter) return failure("blocked", exitOf(judged.decision), movedAfter, input.head);
  if (judged.gate !== CLOSEOUT_GATE) {
    return failure("invalid", exitOf(judged.decision), "decision gate is not beforePR", input.head);
  }
  const judgedDecision = toGateDecision(judged);
  publishReviews(input, judgedDecision, reviewFindings, reviewAttempts, metrics);
  return finish(judgedDecision, input.base, input.head, reviewFindings);
}

/**
 * Run the gate. A rejection is handed to {@link FixRunner} at most
 * {@link MAX_FIX_ATTEMPTS} times. A requirement the spec marks `exhausted`
 * stops the loop and needs a person. Blocked, invalid, and exhausted
 * results do not merge.
 */
export async function runCloseoutGate(input: GateInput): Promise<GateResult> {
  let maxFixAttempts = input.maxFixAttempts;
  if (maxFixAttempts !== undefined && (!Number.isInteger(maxFixAttempts) || maxFixAttempts < 0)) {
    return finalResult(
      input,
      "invalid",
      0,
      0,
      input.head ?? "",
      null,
      "maxFixAttempts must be a non-negative integer",
    );
  }

  let head = input.head;
  if (!head) {
    try {
      head = await readHead(input.worktree);
    } catch (error) {
      journalCaught(error, "run.runCloseoutGate.readHead", input.taskId);
      const message = error instanceof Error ? error.message : String(error);
      return finalResult(input, "invalid", 0, 0, "", null, message);
    }
  }

  let fixAttempts = 0;
  let evaluations = 0;

  for (;;) {
    evaluations += 1;
    const evaluation = await evaluateCandidate({ ...input, head });
    if (input.reportDir) {
      await appendDecisionHistory(input.reportDir, {
        evaluation: evaluations,
        exitCode: evaluation.exitCode,
        decision: evaluation.decision,
        ...(evaluation.error ? { error: evaluation.error } : {}),
      });
    }

    if (evaluation.outcome === "accepted") {
      return finalResult(input, "accepted", fixAttempts, evaluations, head, evaluation);
    }
    if (evaluation.outcome === "exhausted") {
      return finalResult(input, "exhausted", fixAttempts, evaluations, head, evaluation);
    }
    if (evaluation.outcome === "blocked" || evaluation.outcome === "invalid") {
      return finalResult(input, evaluation.outcome, fixAttempts, evaluations, head, evaluation);
    }

    maxFixAttempts ??=
      policyFixBudget(input.worktree, input.home, input.policyRoot) ?? MAX_FIX_ATTEMPTS;
    if (fixAttempts >= maxFixAttempts) {
      return finalResult(input, "exhausted", fixAttempts, evaluations, head, evaluation);
    }

    const feedback = await repairFeedback(input, evaluation);
    const failures: string[] = [];
    let lastThrown: string | undefined;
    let fixed: string | undefined;
    while (fixed === undefined) {
      if (fixAttempts >= maxFixAttempts) {
        return finalResult(
          input,
          "exhausted",
          fixAttempts,
          evaluations,
          head,
          evaluation,
          failures.join("\n"),
        );
      }
      fixAttempts += 1;
      const outcome = await attemptFix(input, {
        worktree: input.worktree,
        taskId: input.taskId,
        fixAttempt: fixAttempts,
        maxFixAttempts,
        base: input.base,
        head,
        items: evaluation.decision?.items ?? [],
        reviewFindings: evaluation.reviewFindings,
        summary: [feedback, ...failures].join("\n\n"),
      });
      if ("head" in outcome) fixed = outcome.head;
      else if (outcome.final || (outcome.thrown && outcome.reason === lastThrown))
        return finalResult(
          input,
          "fix_failed",
          fixAttempts,
          evaluations,
          outcome.at ?? head,
          evaluation,
          outcome.reason,
        );
      else failures.push(`Fix attempt ${fixAttempts} failed: ${outcome.reason}`);
      lastThrown = "thrown" in outcome && outcome.thrown ? outcome.reason : undefined;
    }
    head = fixed;
  }
}

/**
 * Decide `head` from the evidence already recorded for it. Runs no command
 * and no review: an answered pending-human check completes the evaluation
 * the other checks finished. A rejection is final, as with no fix attempts.
 */
export async function decideCloseoutGate(input: GateInput): Promise<GateResult> {
  let head = input.head;
  if (!head) {
    try {
      head = await readHead(input.worktree);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return finalResult(input, "invalid", 0, 0, "", null, message);
    }
  }
  const evaluation = await decideRecorded({ ...input, head });
  if (input.reportDir) {
    await appendDecisionHistory(input.reportDir, {
      evaluation: 1,
      exitCode: evaluation.exitCode,
      decision: evaluation.decision,
      ...(evaluation.error ? { error: evaluation.error } : {}),
    });
  }
  const outcome: GateOutcome = evaluation.outcome === "rejected" ? "exhausted" : evaluation.outcome;
  return finalResult(input, outcome, 0, 1, head, evaluation);
}

async function decideRecorded(input: EvaluateInput): Promise<Evaluation> {
  const taskError = assertTaskId(input.taskId);
  if (taskError) return failure("invalid", null, taskError, input.head);
  if (!isSha(input.base) || !isSha(input.head)) {
    return failure("invalid", null, "base and head must be commit ids", input.head);
  }
  let judged: SpecDecision;
  try {
    judged = await decide({
      checkoutExclusions: input.checkoutExclusions,
      repo: input.worktree,
      base: input.base,
      head: input.head,
      gate: CLOSEOUT_GATE,
      task: input.taskId,
      candidate: input.candidate,
      evidenceDir: evidencePath(input.taskId, input.pawsHome),
      ...(input.home !== undefined ? { home: input.home } : {}),
      ...(input.policyRoot !== undefined ? { policyRoot: input.policyRoot } : {}),
      ...(input.retryBaseline !== undefined ? { retryBaseline: input.retryBaseline } : {}),
      ...publishedOf(input),
    });
  } catch (error) {
    if (isTransient(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return failure("blocked", null, scrub(message), input.head);
  }
  const moved = await headUnmoved(input.worktree, input.head);
  if (moved) return failure("blocked", exitOf(judged.decision), moved, input.head);
  if (judged.gate !== CLOSEOUT_GATE) {
    return failure("invalid", exitOf(judged.decision), "decision gate is not beforePR", input.head);
  }
  return applyBypasses(
    finish(toGateDecision(judged), input.base, input.head, []),
    input.bypasses ?? [],
  );
}

async function attemptFix(
  input: GateInput,
  request: FixRequest,
): Promise<{ head: string } | { reason: string; final: boolean; at?: string; thrown?: boolean }> {
  let fix;
  try {
    fix = await input.fixer.applyFix(request);
  } catch (error) {
    journalCaught(
      error,
      "run.attemptFix.applyFix",
      input.taskId,
      "cancellation may interrupt work",
    );
    return {
      reason: error instanceof Error ? error.message : String(error),
      final: error instanceof Error && error.name === "AbortError",
      thrown: true,
    };
  }
  if (!fix.ok) return { reason: fix.reason, final: fix.reason === "fix cancelled" };
  let actual: string;
  try {
    actual = await readHead(input.worktree);
  } catch (error) {
    journalCaught(error, "run.attemptFix.readHead", input.taskId);
    return { reason: error instanceof Error ? error.message : String(error), final: true };
  }
  if (fix.head !== actual)
    return { reason: "fix did not move HEAD to a new commit", final: true, at: actual };
  if (fix.head === request.head && !evidenceOnly(request.items))
    return { reason: "fix did not move HEAD to a new commit", final: false };
  return { head: fix.head };
}

/** Publishing a screenshot or video needs no new commit. */
export function evidenceOnly(items: readonly CloseoutItem[]): boolean {
  const failed = items.filter((item) => item.state === "failed");
  return failed.length > 0 && failed.every((item) => item.kind === "evidence");
}

function publishedOf(input: EvaluateInput): {
  published?: readonly PublishedEvidence[];
  approvals?: readonly EvidenceApproval[];
} {
  const published = input.published?.();
  const approvals = input.approvals?.();
  return { ...(published ? { published } : {}), ...(approvals ? { approvals } : {}) };
}

export function snapshotRetryBaseline(taskId: string, pawsHome?: string): Promise<string[]> {
  return readRetryBaseline(evidencePath(taskId, pawsHome));
}

async function repairFeedback(input: GateInput, evaluation: Evaluation): Promise<string> {
  const decision = evaluation.decision;
  if (decision === null) return evaluation.error ?? "closeout rejected the candidate";
  const waived = new Set(evaluation.bypasses?.flatMap((approval) => [...approval.checkIds]) ?? []);
  const parts = [
    formatFixFeedback(
      { ...decision, items: decision.items.filter((item) => !waived.has(item.id)) },
      evaluation.reviewFindings,
    ),
  ];
  for (const item of decision.items) {
    if (
      waived.has(item.id) ||
      item.kind !== "command" ||
      item.state !== "failed" ||
      item.attempt === undefined
    )
      continue;
    const file = path.join(
      evidencePath(input.taskId, input.pawsHome),
      "logs",
      decision.policy.digest?.replace(/^sha256:/, "") ?? "",
      decision.head,
      ...item.id.split("/"),
      `${item.attempt}.log`,
    );
    try {
      parts.push(`${item.id} output:\n${scrub((await readFile(file, "utf8")).slice(-4000))}`);
    } catch (caughtError2) {
      journalCaught(caughtError2, "run.repairFeedback.push", input.taskId);
      parts.push(`${item.id} log is unavailable.`);
    }
  }
  return parts.join("\n\n");
}

type ReviewMetrics = Map<string, { durationMs: number; tokens: number | null }>;

async function startParallelReviews(
  input: EvaluateInput,
  evidenceDir: string,
  reviewFindings: ReviewFindings[],
  reviewAttempts: Map<string, number>,
  metrics: ReviewMetrics,
): Promise<{ gaps: CloseoutItem[]; done: Promise<Evaluation | null> } | undefined> {
  const required = reviewRequirements(input.worktree, input.home, input.policyRoot);
  if (!required.ok) return undefined;
  const parallel = new Set(required.items.filter((item) => item.parallel).map((item) => item.id));
  if (parallel.size === 0) return undefined;
  let before: DecisionDocument;
  try {
    before = toGateDecision(
      await decide({
        checkoutExclusions: input.checkoutExclusions,
        repo: input.worktree,
        base: input.base,
        head: input.head,
        gate: CLOSEOUT_GATE,
        task: input.taskId,
        candidate: input.candidate,
        evidenceDir,
        ...(input.home !== undefined ? { home: input.home } : {}),
        ...(input.policyRoot !== undefined ? { policyRoot: input.policyRoot } : {}),
        ...(input.retryBaseline !== undefined ? { retryBaseline: input.retryBaseline } : {}),
        ...publishedOf(input),
      }),
    );
  } catch (caughtError3) {
    journalCaught(caughtError3, "run.startParallelReviews.toGateDecision", input.taskId);
    return undefined;
  }
  const gaps = reviewGaps(before).filter((item) => parallel.has(item.id));
  if (gaps.length === 0) return undefined;
  const done = addReviewEvidence(
    input,
    gaps,
    reviewFindings,
    reviewAttempts,
    metrics,
    evidenceDir,
    progressIdentity(input.taskId, before),
  );
  done.catch((caughtError4) => {
    journalCaught(caughtError4, "run.startParallelReviews", input.taskId);
    return null;
  });
  return { gaps, done };
}

function withoutReviewPlan(
  progress: CloseoutProgress,
  reviews: readonly CloseoutItem[],
): CloseoutProgress {
  return {
    begin: (identity) => progress.begin(identity),
    step(identity, step) {
      if (step.kind === "review" && reviews.some((item) => item.id === step.id)) return;
      progress.step(identity, step);
    },
    output: (identity, stepId, stream, chunk, truncated) =>
      progress.output(identity, stepId, stream, chunk, truncated),
    finish: (identity, decision) => progress.finish(identity, decision),
  };
}

/** origin/main could not be read for the policy because of a temporary git failure. */
export class PolicyFetchError extends Error {
  override name = "PolicyFetchError";
}

const REVIEW_RETRY_DELAYS_MS = [30_000, 120_000, 300_000];
const TRANSIENT_REVIEW_ERROR =
  /rate.?limit|too many requests|\b429\b|\b5\d\d\b|overloaded|temporarily unavailable/i;

async function reviewWithRetries<T>(input: EvaluateInput, review: () => Promise<T>): Promise<T> {
  const delays = input.reviewRetryDelaysMs ?? REVIEW_RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      return await review();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= delays.length || !TRANSIENT_REVIEW_ERROR.test(message)) throw error;
      journalCaught(error, "run.reviewWithRetries.review", input.taskId);
      await new Promise((resume) => setTimeout(resume, delays[attempt]));
    }
  }
}

async function addReviewEvidence(
  input: EvaluateInput,
  items: CloseoutItem[],
  reviewFindings: ReviewFindings[],
  reviewAttempts: Map<string, number>,
  metrics: ReviewMetrics,
  evidenceDir: string,
  identity: CloseoutProgressIdentity,
): Promise<Evaluation | null> {
  for (const item of items) {
    noteReview(input, identity, item.id, "running", item.message, null, item.attempt ?? null);
    const started = Date.now();
    let tokens: number | null = null;
    let added;
    try {
      added = await addReview({
        checkoutExclusions: input.checkoutExclusions,
        repo: input.worktree,
        base: input.base,
        head: input.head,
        gate: CLOSEOUT_GATE,
        task: input.taskId,
        itemId: item.id,
        candidate: input.candidate,
        evidenceDir,
        ...(input.home !== undefined ? { home: input.home } : {}),
        ...(input.policyRoot !== undefined ? { policyRoot: input.policyRoot } : {}),
        ...(input.retryBaseline !== undefined ? { retryBaseline: input.retryBaseline } : {}),
        reviewer: {
          async review(request) {
            const result = await reviewWithRetries(input, async () =>
              input.reviewer.review({
                worktree: request.worktree,
                prompt: renderReviewPrompt(
                  await loadReviewMaterial({
                    repo: request.worktree,
                    skill: request.item.skill,
                    skillFiles: request.skillFiles,
                    base: request.base,
                    head: request.head,
                  }),
                  request.base,
                  request.head,
                  request.item.scope,
                  request.earlier,
                ),
                taskId: input.taskId,
                itemId: request.item.id,
                base: request.base,
                head: request.head,
                candidate: {
                  session: request.candidate.session,
                  model: request.candidate.model,
                  provider: request.candidate.provider,
                },
              }),
            );
            tokens = result.tokens ?? null;
            return {
              producer: {
                session: result.session,
                model: result.model,
                provider: result.provider,
              },
              findings: result.findings,
              artifacts: [],
            };
          },
        },
      });
    } catch (error) {
      if (isTransient(error)) throw error;
      journalCaught(error, "run.addReviewEvidence.addReview", input.taskId);
      const message = error instanceof Error ? error.message : String(error);
      const detail = scrub(`reviewer failed for ${item.id}: ${message}`);
      noteReview(input, identity, item.id, "blocked", detail, null, item.attempt ?? null, null, {
        durationMs: Date.now() - started,
        tokens,
      });
      return failure("blocked", null, detail, input.head);
    }
    metrics.set(item.id, { durationMs: Date.now() - started, tokens });
    if (!added.ok) {
      const detail = scrub(`${item.id}: ${added.message}`);
      const refreshed = toGateDecision(
        await decide({
          checkoutExclusions: input.checkoutExclusions,
          repo: input.worktree,
          base: input.base,
          head: input.head,
          gate: CLOSEOUT_GATE,
          task: input.taskId,
          candidate: input.candidate,
          evidenceDir,
          ...(input.home !== undefined ? { home: input.home } : {}),
          ...(input.policyRoot !== undefined ? { policyRoot: input.policyRoot } : {}),
          ...(input.retryBaseline !== undefined ? { retryBaseline: input.retryBaseline } : {}),
          ...publishedOf(input),
        }),
      );
      if (refreshed.items.some((entry) => entry.state === "exhausted")) {
        publishReviews(input, refreshed, reviewFindings, reviewAttempts, metrics);
        return finish(refreshed, input.base, input.head, reviewFindings);
      }
      noteReview(
        input,
        identity,
        item.id,
        "blocked",
        detail,
        null,
        item.attempt ?? null,
        null,
        metrics.get(item.id),
      );
      return failure("blocked", null, detail, input.head);
    }
    const findings = added.record.findings;
    const preExisting = await preExistingFindings(input.worktree, input.base, input.head, findings);
    reviewFindings.push({
      itemId: item.id,
      findings,
      ...(preExisting.length > 0 ? { preExisting } : {}),
    });
    reviewAttempts.set(item.id, added.record.attempt);
  }
  return null;
}

function progressIdentity(
  taskId: string,
  decision: { base: string; head: string; policy: { digest: string | null; path: string | null } },
): CloseoutProgressIdentity {
  return {
    taskId,
    base: decision.base,
    head: decision.head,
    policyDigest: decision.policy.digest ?? "",
    policyPath: decision.policy.path,
  };
}

function noteReview(
  input: EvaluateInput,
  identity: CloseoutProgressIdentity,
  id: string,
  state: CloseoutStepState,
  detail: string,
  findings: string | null,
  attempt: number | null,
  reviewEvidencePath: string | null = null,
  measured?: { durationMs: number; tokens: number | null },
): void {
  const running = state === "running" || state === "pending";
  input.progress?.step(identity, {
    id,
    kind: "review",
    state,
    command: "",
    detail: scrub(detail),
    attempt: attempt ?? 0,
    timeoutSeconds: null,
    startedAt: state === "running" ? Date.now() : null,
    finishedAt: running ? null : Date.now(),
    exitCode: null,
    timedOut: false,
    timeoutReason: null,
    truncated: false,
    logPath: null,
    evidencePath: reviewEvidencePath,
    findings: findings === null ? null : scrub(findings),
    ordinal: -1,
    ...measured,
  });
}

function publishReviews(
  input: EvaluateInput,
  decision: DecisionDocument,
  reviewFindings: ReviewFindings[],
  reviewAttempts: Map<string, number>,
  metrics: ReviewMetrics,
): void {
  const identity = progressIdentity(input.taskId, decision);
  for (const item of decision.items) {
    if (item.kind !== "review") continue;
    const found = reviewFindings.find((entry) => entry.itemId === item.id);
    const attempt = item.attempt ?? reviewAttempts.get(item.id);
    const reviewEvidencePath =
      attempt !== undefined && attempt > 0
        ? [
            "evidence",
            identity.policyDigest.replace(/^sha256:/, ""),
            identity.head,
            ...item.id.split("/"),
            `${attempt}.json`,
          ].join("/")
        : null;
    noteReview(
      input,
      identity,
      item.id,
      reviewStepState(item.state),
      item.message,
      found ? findingText(found) : null,
      attempt ?? null,
      reviewEvidencePath,
      metrics.get(item.id),
    );
  }
}

function reviewStepState(state: string): CloseoutStepState {
  if (state === "passed" || state === "failed" || state === "skipped" || state === "exhausted") {
    return state;
  }
  if (state === "missing" || state === "stale") return "pending";
  return "blocked";
}

function findingText(review: ReviewFindings): string | null {
  if (review.findings.length === 0) return null;
  return scrub(
    review.findings
      .map(
        (finding) =>
          `${finding.severity} ${finding.location}: ${finding.explanation}${review.preExisting?.includes(finding) ? " (pre-existing, does not block)" : ""}`,
      )
      .join("\n"),
  );
}

function scrub(text: string): string {
  return scrubText(text, credentialSecrets());
}

function finish(
  decision: DecisionDocument,
  requestedBase: string,
  requestedHead: string,
  reviewFindings: Evaluation["reviewFindings"],
): Evaluation {
  const exitCode = exitOf(decision.decision);
  if (decision.base !== requestedBase || decision.head !== requestedHead) {
    return failure(
      "blocked",
      exitCode,
      "decision commit ids do not match the candidate",
      requestedHead,
    );
  }
  if (decision.items.some((item) => item.state === "exhausted")) {
    return { outcome: "exhausted", exitCode, decision, reviewFindings, head: requestedHead };
  }
  const unsatisfied = decision.items.some(
    (item) => item.state !== "passed" && item.state !== "skipped",
  );
  if (decision.decision === "accepted" && unsatisfied) {
    return failure(
      "invalid",
      exitCode,
      "accepted decision contains an unsatisfied item",
      requestedHead,
    );
  }
  if (decision.decision === "accepted") {
    return { outcome: "accepted", exitCode, decision, reviewFindings, head: requestedHead };
  }
  if (decision.decision === "rejected") {
    return { outcome: "rejected", exitCode, decision, reviewFindings, head: requestedHead };
  }
  return { outcome: "blocked", exitCode, decision, reviewFindings, head: requestedHead };
}

function failure(
  outcome: Evaluation["outcome"],
  exitCode: number | null,
  error: string,
  head: string,
): Evaluation {
  return { outcome, exitCode, decision: null, error, reviewFindings: [], head };
}

function reviewGaps(decision: DecisionDocument): CloseoutItem[] {
  return decision.items.filter(
    (item) => item.kind === "review" && (item.state === "missing" || item.state === "stale"),
  );
}

function toGateDecision(document: SpecDecision): DecisionDocument {
  const decision: DecisionDocument = {
    specVersion: "0.1",
    decision: document.decision,
    gate: CLOSEOUT_GATE,
    base: document.base,
    head: document.head,
    candidate: {
      session: document.candidate.session,
      model: document.candidate.model,
      provider: document.candidate.provider,
      ...(document.candidate.task !== undefined ? { task: document.candidate.task } : {}),
    },
    policy: {
      path: document.policy.path,
      digest: document.policy.digest,
      absent: document.policy.absent,
    },
    items: document.items.map((item) => ({
      id: item.id,
      kind: item.kind,
      state: item.state,
      message: item.message,
      ...(item.attempt !== undefined ? { attempt: item.attempt } : {}),
    })),
    warnings: document.warnings.map((warning) => ({
      code: warning.code,
      message: warning.message,
    })),
  };
  if (document.message !== undefined) decision.message = document.message;
  return decision;
}

function exitOf(name: DecisionDocument["decision"]): 0 | 1 | 3 {
  if (name === "accepted") return 0;
  if (name === "rejected") return 1;
  return 3;
}

function evidencePath(taskId: string, pawsHome: string | undefined): string {
  const safe = taskId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200);
  return path.join(pawsHome ?? tmpdir(), "closeout", "evidence", safe);
}

function assertTaskId(taskId: string): string | null {
  if (typeof taskId !== "string" || taskId.length === 0 || taskId.trim() !== taskId) {
    return "task id must be a nonblank string";
  }
  if (taskId.includes("\0") || taskId.startsWith("-")) {
    return "task id must not start with '-' or contain NUL";
  }
  if (Buffer.byteLength(taskId, "utf8") > 256) {
    return "task id must be at most 256 bytes";
  }
  return null;
}

async function headUnmoved(worktree: string, head: string): Promise<string | null> {
  try {
    const actual = await readHead(worktree);
    if (actual !== head) return "worktree HEAD changed while closeout ran";
    return null;
  } catch (error) {
    journalCaught(error, "run.headUnmoved.readHead", null);
    return error instanceof Error ? error.message : String(error);
  }
}

async function finalResult(
  input: GateInput,
  outcome: GateOutcome,
  fixAttempts: number,
  evaluations: number,
  head: string,
  evaluation: Evaluation | null,
  error?: string,
): Promise<GateResult> {
  const decision = evaluation?.decision ?? null;
  const summaryParts = [
    formatEvidenceSummary({
      outcome,
      taskId: input.taskId,
      ...(input.taskLabel ? { taskLabel: input.taskLabel } : {}),
      base: input.base,
      head,
      fixAttempts,
      evaluations,
      exitCode: evaluation?.exitCode ?? null,
      decision,
    }),
  ];
  if (evaluation?.bypasses?.length) summaryParts.push(bypassSummary(evaluation.bypasses));
  if (error) summaryParts.push(error);
  if (evaluation?.error && evaluation.error !== error) summaryParts.push(evaluation.error);
  const handoff =
    input.maxFixAttempts === 0 && evaluation?.decision?.decision === "rejected"
      ? await repairFeedback(input, evaluation)
      : undefined;
  const result: GateResult = {
    ...(handoff ? { handoff } : {}),
    outcome,
    taskId: input.taskId,
    base: input.base,
    head,
    fixAttempts,
    evaluations,
    exitCode: evaluation?.exitCode ?? null,
    decision,
    summary: summaryParts.join("\n"),
    ...(evaluation?.bypasses ? { bypasses: evaluation.bypasses } : {}),
  };
  if (input.reportDir) {
    result.reportPath = await writeVerdictReport(input.reportDir, result);
  }
  if (input.recorder) await input.recorder.record(result);
  seal(input.progress, outcome);
  return result;
}
