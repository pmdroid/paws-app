import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FixRunner } from "./fixer";
import { assertTaskId, interpretCloseoutOutput, isSha } from "./parse";
import { appendDecisionHistory, writeVerdictReport, type VerdictRecorder } from "./report";
import type { CodexReviewer } from "./reviewer";
import {
  decisionArgs,
  evidenceAddArgs,
  runArgs,
  spawnCloseout,
  validateFindings,
  versionMatches,
  type SpawnResult,
} from "./spawn";
import { formatEvidenceSummary, formatFixFeedback } from "./summary";
import {
  CLOSEOUT_GATE,
  MAX_FIX_ATTEMPTS,
  PINNED_CLOSEOUT_VERSION,
  type CandidateIdentity,
  type CloseoutItem,
  type DecisionDocument,
  type Finding,
  type GateOutcome,
  type GateResult,
} from "./types";
import { readHead } from "./worktree";

export type EvaluateInput = {
  worktree: string;
  taskId: string;
  base: string;
  head: string;
  candidate: CandidateIdentity;
  reviewer: CodexReviewer;
  closeoutBin?: string;
  pinnedVersion?: string;
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
  closeoutBin?: string;
  pinnedVersion?: string;
  maxFixAttempts?: number;
};

type Invocation = { exitCode: number | null; decision: DecisionDocument | null; error?: string };

/**
 * One Closeout evaluation: `closeout run`, then Codex review evidence for
 * any review item that is missing or stale, then `closeout decision`.
 * Does not ask the implementer to fix anything.
 */
export async function evaluateCandidate(input: EvaluateInput): Promise<Evaluation> {
  const taskError = assertTaskId(input.taskId);
  if (taskError) return failure("invalid", null, taskError, input.head);
  if (!isSha(input.base) || !isSha(input.head)) {
    return failure("invalid", null, "base and head must be commit ids", input.head);
  }

  const bin = input.closeoutBin ?? process.env.CLOSEOUT_BIN ?? "closeout";
  const pinned = input.pinnedVersion ?? PINNED_CLOSEOUT_VERSION;
  const version = await spawnCloseout({ bin, args: ["--version"], cwd: input.worktree });
  if (version.spawnError) {
    return failure(
      "blocked",
      null,
      `pinned closeout binary is missing: ${version.spawnError}`,
      input.head,
    );
  }
  const versionText = `${version.stdout}\n${version.stderr}`;
  if (version.exitCode !== 0 || !versionMatches(versionText, pinned)) {
    return failure(
      "blocked",
      version.exitCode,
      `closeout version is not pinned to ${pinned}`,
      input.head,
    );
  }

  const run = await invoke(bin, input.worktree, runArgs(input));
  const moved = await headUnmoved(input.worktree, input.head);
  if (moved) return failure("blocked", run.exitCode, moved, input.head);
  if (!run.decision) {
    return failure("invalid", run.exitCode, run.error ?? "closeout run failed", input.head);
  }
  if (run.decision.base !== input.base || run.decision.head !== input.head) {
    return failure(
      "blocked",
      run.exitCode,
      "decision commit ids do not match the candidate",
      input.head,
    );
  }

  const reviewFindings: Array<{ itemId: string; findings: Finding[] }> = [];
  const gaps = reviewGaps(run.decision);
  if (gaps.length > 0) {
    const filled = await addReviewEvidence({ bin, input, items: gaps, reviewFindings });
    if (filled) return { ...filled, reviewFindings };
    const decided = await invoke(bin, input.worktree, decisionArgs(input));
    const movedAfter = await headUnmoved(input.worktree, input.head);
    if (movedAfter) return failure("blocked", decided.exitCode, movedAfter, input.head);
    if (!decided.decision) {
      return failure(
        "invalid",
        decided.exitCode,
        decided.error ?? "closeout decision failed",
        input.head,
      );
    }
    return finish(decided, input.base, input.head, reviewFindings);
  }

  return finish(run, input.base, input.head, reviewFindings);
}

/**
 * Run the gate. A rejection is handed to {@link FixRunner} at most
 * {@link MAX_FIX_ATTEMPTS} times. Blocked, invalid, and exhausted
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

async function addReviewEvidence(input: {
  bin: string;
  input: EvaluateInput;
  items: CloseoutItem[];
  reviewFindings: Array<{ itemId: string; findings: Finding[] }>;
}): Promise<Evaluation | null> {
  for (const item of input.items) {
    let review;
    try {
      review = await input.input.reviewer.review({
        worktree: input.input.worktree,
        taskId: input.input.taskId,
        itemId: item.id,
        base: input.input.base,
        head: input.input.head,
        candidate: input.input.candidate,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure(
        "blocked",
        null,
        `reviewer failed for ${item.id}: ${message}`,
        input.input.head,
      );
    }
    const findingsError = validateFindings(review.findings);
    if (findingsError) {
      return failure("blocked", null, `${item.id}: ${findingsError}`, input.input.head);
    }
    input.reviewFindings.push({ itemId: item.id, findings: review.findings });
    const dir = await mkdtemp(path.join(tmpdir(), "paws-findings-"));
    const findingsPath = path.join(dir, "findings.json");
    try {
      await writeFile(findingsPath, JSON.stringify(review.findings));
      const added = await spawnCloseout({
        bin: input.bin,
        cwd: input.input.worktree,
        args: evidenceAddArgs({
          itemId: item.id,
          base: input.input.base,
          head: input.input.head,
          taskId: input.input.taskId,
          session: review.session,
          model: review.model,
          provider: review.provider,
          findingsPath,
        }),
      });
      if (added.spawnError || added.exitCode !== 0) {
        return failure(
          "blocked",
          added.exitCode,
          added.spawnError ?? `evidence add failed for ${item.id}: ${added.stderr.trim()}`,
          input.input.head,
        );
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  return null;
}

async function invoke(bin: string, cwd: string, args: string[]): Promise<Invocation> {
  const spawned = await spawnCloseout({ bin, args, cwd });
  return invocationFrom(spawned);
}

function invocationFrom(spawned: SpawnResult): Invocation {
  if (spawned.spawnError) {
    return { exitCode: null, decision: null, error: spawned.spawnError };
  }
  const interpreted = interpretCloseoutOutput(spawned.exitCode, spawned.stdout);
  if (!interpreted.ok) {
    return { exitCode: spawned.exitCode, decision: null, error: interpreted.error };
  }
  if (interpreted.decision.gate !== CLOSEOUT_GATE) {
    return { exitCode: spawned.exitCode, decision: null, error: "decision gate is not beforePR" };
  }
  return { exitCode: spawned.exitCode, decision: interpreted.decision };
}

function finish(
  invocation: Invocation,
  requestedBase: string,
  requestedHead: string,
  reviewFindings: Evaluation["reviewFindings"],
): Evaluation {
  const decision = invocation.decision;
  if (!decision) {
    return failure(
      "invalid",
      invocation.exitCode,
      invocation.error ?? "no decision",
      requestedHead,
    );
  }
  if (decision.base !== requestedBase || decision.head !== requestedHead) {
    return failure(
      "blocked",
      invocation.exitCode,
      "decision commit ids do not match the candidate",
      requestedHead,
    );
  }
  if (decision.items.some((item) => item.state === "exhausted")) {
    return {
      outcome: "exhausted",
      exitCode: invocation.exitCode,
      decision,
      reviewFindings,
      head: requestedHead,
    };
  }
  const unsatisfied = decision.items.some(
    (item) => item.state !== "passed" && item.state !== "skipped",
  );
  if (decision.decision === "accepted" && unsatisfied) {
    return failure(
      "invalid",
      invocation.exitCode,
      "accepted decision contains an unsatisfied item",
      requestedHead,
    );
  }
  if (decision.decision === "accepted") {
    return {
      outcome: "accepted",
      exitCode: invocation.exitCode,
      decision,
      reviewFindings,
      head: requestedHead,
    };
  }
  if (decision.decision === "rejected") {
    return {
      outcome: "rejected",
      exitCode: invocation.exitCode,
      decision,
      reviewFindings,
      head: requestedHead,
    };
  }
  return {
    outcome: "blocked",
    exitCode: invocation.exitCode,
    decision,
    reviewFindings,
    head: requestedHead,
  };
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
