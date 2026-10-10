import type { FixRunner } from "./fixer";
import { appendDecisionHistory, writeVerdictReport, type VerdictRecorder } from "./report";
import type { CodexReviewer } from "./reviewer";
import { formatEvidenceSummary, formatFixFeedback } from "./summary";
import {
  CLOSEOUT_GATE,
  MAX_FIX_ATTEMPTS,
  type CandidateIdentity,
  type CloseoutItem,
  type DecisionDocument,
  type Finding,
  type GateOutcome,
  type GateResult,
} from "./types";
import { isSha, readHead } from "./worktree";
import { addReview, decision, run, type DecisionDocument as SpecDecision } from "../closeout-spec";

export type EvaluateInput = {
  worktree: string;
  taskId: string;
  base: string;
  head: string;
  candidate: CandidateIdentity;
  reviewer: CodexReviewer;
  /** Home for `~/.agents/closeout.yaml` when origin/main has no entry. */
  home?: string;
  /** `~/.paws` for the detached command worktree. */
  pawsHome?: string;
};

export type Evaluation = {
  outcome: "accepted" | "rejected" | "exhausted" | "blocked" | "invalid";
  exitCode: number | null;
  decision: DecisionDocument | null;
  error?: string;
  reviewFindings: Array<{ itemId: string; findings: Finding[] }>;
  head: string;
};

export type GateInput = {
  worktree: string;
  taskId: string;
  base: string;
  /** Defaults to `git rev-parse HEAD` in the worktree. */
  head?: string;
  candidate: CandidateIdentity;
  reviewer: CodexReviewer;
  fixer: FixRunner;
  recorder?: VerdictRecorder;
  reportDir?: string;
  home?: string;
  pawsHome?: string;
  maxFixAttempts?: number;
};

/**
 * One Closeout evaluation: native `run`, then Codex review evidence for any
 * review item that is missing or stale, then native `decision`.
 * Does not ask the implementer to fix anything.
 * Task id is the work item id.
 */
export async function evaluateCandidate(input: EvaluateInput): Promise<Evaluation> {
  const taskError = assertTaskId(input.taskId);
  if (taskError) return failure("invalid", null, taskError, input.head);
  if (!isSha(input.base) || !isSha(input.head)) {
    return failure("invalid", null, "base and head must be commit ids", input.head);
  }

  let ran: SpecDecision;
  try {
    ran = await run({
      repo: input.worktree,
      base: input.base,
      head: input.head,
      gate: CLOSEOUT_GATE,
      task: input.taskId,
      candidate: input.candidate,
      ...(input.home !== undefined ? { home: input.home } : {}),
      ...(input.pawsHome !== undefined ? { pawsHome: input.pawsHome } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure("blocked", null, message, input.head);
  }
  const moved = await headUnmoved(input.worktree, input.head);
  if (moved) return failure("blocked", exitOf(ran.decision), moved, input.head);
  if (ran.gate !== CLOSEOUT_GATE) {
    return failure("invalid", exitOf(ran.decision), "decision gate is not beforePR", input.head);
  }

  const first = toGateDecision(ran);
  const reviewFindings: Array<{ itemId: string; findings: Finding[] }> = [];
  const gaps = reviewGaps(first);
  if (gaps.length === 0) return finish(first, input.base, input.head, reviewFindings);

  const filled = await addReviewEvidence(input, gaps, reviewFindings);
  if (filled) return filled;

  let judged: SpecDecision;
  try {
    judged = await decision({
      repo: input.worktree,
      base: input.base,
      head: input.head,
      gate: CLOSEOUT_GATE,
      task: input.taskId,
      candidate: input.candidate,
      ...(input.home !== undefined ? { home: input.home } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure("blocked", null, message, input.head);
  }
  const movedAfter = await headUnmoved(input.worktree, input.head);
  if (movedAfter) return failure("blocked", exitOf(judged.decision), movedAfter, input.head);
  if (judged.gate !== CLOSEOUT_GATE) {
    return failure("invalid", exitOf(judged.decision), "decision gate is not beforePR", input.head);
  }
  return finish(toGateDecision(judged), input.base, input.head, reviewFindings);
}

/**
 * Run the gate. A rejection is handed to {@link FixRunner} at most
 * {@link MAX_FIX_ATTEMPTS} times. A requirement the spec marks `exhausted`
 * stops the loop and needs a person. Blocked, invalid, and exhausted
 * results do not merge.
 */
export async function runCloseoutGate(input: GateInput): Promise<GateResult> {
  const maxFixAttempts = input.maxFixAttempts ?? MAX_FIX_ATTEMPTS;
  if (!Number.isInteger(maxFixAttempts) || maxFixAttempts < 0) {
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

    if (fixAttempts >= maxFixAttempts) {
      return finalResult(input, "exhausted", fixAttempts, evaluations, head, evaluation);
    }

    fixAttempts += 1;
    let fix;
    try {
      fix = await input.fixer.applyFix({
        worktree: input.worktree,
        taskId: input.taskId,
        fixAttempt: fixAttempts,
        maxFixAttempts,
        base: input.base,
        head,
        items: evaluation.decision?.items ?? [],
        reviewFindings: evaluation.reviewFindings,
        summary: evaluation.decision
          ? formatFixFeedback(evaluation.decision, evaluation.reviewFindings)
          : (evaluation.error ?? "closeout rejected the candidate"),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return finalResult(input, "fix_failed", fixAttempts, evaluations, head, evaluation, message);
    }
    if (!fix.ok) {
      return finalResult(
        input,
        "fix_failed",
        fixAttempts,
        evaluations,
        head,
        evaluation,
        fix.reason,
      );
    }
    let actual: string;
    try {
      actual = await readHead(input.worktree);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return finalResult(input, "fix_failed", fixAttempts, evaluations, head, evaluation, message);
    }
    if (fix.head !== actual || fix.head === head) {
      return finalResult(
        input,
        "fix_failed",
        fixAttempts,
        evaluations,
        actual,
        evaluation,
        "fix did not move HEAD to a new commit",
      );
    }
    head = fix.head;
  }
}

async function addReviewEvidence(
  input: EvaluateInput,
  items: CloseoutItem[],
  reviewFindings: Array<{ itemId: string; findings: Finding[] }>,
): Promise<Evaluation | null> {
  for (const item of items) {
    let added;
    try {
      added = await addReview({
        repo: input.worktree,
        base: input.base,
        head: input.head,
        gate: CLOSEOUT_GATE,
        task: input.taskId,
        itemId: item.id,
        candidate: input.candidate,
        ...(input.home !== undefined ? { home: input.home } : {}),
        reviewer: {
          async review(request) {
            const result = await input.reviewer.review({
              worktree: request.worktree,
              taskId: input.taskId,
              itemId: request.item.id,
              base: request.base,
              head: request.head,
              candidate: {
                session: request.candidate.session,
                model: request.candidate.model,
                provider: request.candidate.provider,
              },
            });
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
      const message = error instanceof Error ? error.message : String(error);
      return failure("blocked", null, `reviewer failed for ${item.id}: ${message}`, input.head);
    }
    if (!added.ok) {
      return failure("blocked", null, `${item.id}: ${added.message}`, input.head);
    }
    reviewFindings.push({ itemId: item.id, findings: added.record.findings });
  }
  return null;
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
      base: input.base,
      head,
      fixAttempts,
      evaluations,
      exitCode: evaluation?.exitCode ?? null,
      decision,
    }),
  ];
  if (error) summaryParts.push(error);
  if (evaluation?.error && evaluation.error !== error) summaryParts.push(evaluation.error);
  const result: GateResult = {
    outcome,
    taskId: input.taskId,
    base: input.base,
    head,
    fixAttempts,
    evaluations,
    exitCode: evaluation?.exitCode ?? null,
    decision,
    summary: summaryParts.join("\n"),
  };
  if (input.reportDir) {
    result.reportPath = await writeVerdictReport(input.reportDir, result);
  }
  if (input.recorder) await input.recorder.record(result);
  return result;
}
