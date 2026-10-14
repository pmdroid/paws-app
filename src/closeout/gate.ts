import type { PawsCommandRunner } from "../closeout-spec";
import type { FixRunner } from "./fixer";
import { runCloseoutGate, type GateInput } from "./run";
import type { CodexReviewer } from "./reviewer";
import type { CandidateIdentity, GateResult } from "./types";

export type CloseoutDecision = "accepted" | "rejected" | "blocked" | "invalid";

export type CloseoutRunInput = {
  taskId: string;
  worktree: string;
  baseSha: string;
  headSha: string;
  attempt: number;
};

export type CloseoutVerdict = {
  decision: CloseoutDecision;
  exhausted: boolean;
  summary: string;
  result?: GateResult;
};

/**
 * Runs native Closeout in the worktree.
 * Command items and the Codex review item stay on this gate seam.
 */
export interface CloseoutGate {
  run(input: CloseoutRunInput): Promise<CloseoutVerdict>;
}

export type CloseoutGateOptions = {
  checkoutExclusions?: readonly string[];
  /** Implementer identity. The Codex hook must use a different session and model. */
  candidate: CandidateIdentity;
  reviewer: CodexReviewer;
  fixer: FixRunner;
  /** Home for `~/.agents/closeout.yaml` when origin/main has no entry. */
  home?: string;
  policyRoot?: string;
  /** `~/.paws` for the detached command worktree. */
  pawsHome?: string;
  reportDir?: string;
  recorder?: GateInput["recorder"];
  maxFixAttempts?: number;
  retryBaseline?: readonly string[];
  bypasses?: GateInput["bypasses"];
  progress?: GateInput["progress"];
  commandRunner?: Pick<PawsCommandRunner, "runLogged">;
};

/**
 * Real gate. `run` owns the fix loop (at most two fixes). `attempt` on the
 * input is the caller's 1-based try and is recorded; it does not reset the loop.
 */
export function createCloseoutGate(options: CloseoutGateOptions): CloseoutGate {
  return {
    async run(input) {
      if (!Number.isInteger(input.attempt) || input.attempt < 1) {
        return {
          decision: "invalid",
          exhausted: false,
          summary: "attempt must be a positive integer",
        };
      }
      const result = await runCloseoutGate({
        checkoutExclusions: options.checkoutExclusions,
        worktree: input.worktree,
        taskId: input.taskId,
        base: input.baseSha,
        head: input.headSha,
        candidate: options.candidate,
        reviewer: options.reviewer,
        fixer: options.fixer,
        ...(options.home !== undefined ? { home: options.home } : {}),
        ...(options.policyRoot !== undefined ? { policyRoot: options.policyRoot } : {}),
        ...(options.pawsHome !== undefined ? { pawsHome: options.pawsHome } : {}),
        ...(options.reportDir ? { reportDir: options.reportDir } : {}),
        ...(options.recorder ? { recorder: options.recorder } : {}),
        ...(options.maxFixAttempts !== undefined ? { maxFixAttempts: options.maxFixAttempts } : {}),
        ...(options.bypasses ? { bypasses: options.bypasses } : {}),
        ...(options.retryBaseline ? { retryBaseline: options.retryBaseline } : {}),
        ...(options.progress ? { progress: options.progress } : {}),
        ...(options.commandRunner ? { commandRunner: options.commandRunner } : {}),
      });
      return toVerdict(result, input.attempt);
    },
  };
}

function toVerdict(result: GateResult, attempt: number): CloseoutVerdict {
  const summary = `${result.summary}\nCaller attempt: ${attempt}`;
  if (result.outcome === "accepted") {
    return { decision: "accepted", exhausted: false, summary, result };
  }
  if (result.outcome === "invalid") {
    return { decision: "invalid", exhausted: false, summary, result };
  }
  const exhausted = result.outcome === "exhausted";
  const decision: CloseoutDecision =
    result.decision?.decision === "rejected" ? "rejected" : "blocked";
  return { decision, exhausted, summary, result };
}
