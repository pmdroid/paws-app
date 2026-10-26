import type { CloseoutItem, ReviewFindings } from "./types";

/**
 * Fix feedback hook. The ACP runner implements this: it resumes the
 * implementer session (or starts a fresh one) with {@link FixRequest.summary}
 * and the failed items, then commits in the worktree.
 */
export type FixRequest = {
  worktree: string;
  taskId: string;
  /** 1-based. */
  fixAttempt: number;
  /**
   * The limit that stops the loop first: the gate's fix budget, or the fix attempts left before a
   * check that fails every time spends the policy's attempts per check.
   */
  maxFixAttempts: number;
  base: string;
  head: string;
  items: CloseoutItem[];
  reviewFindings: ReviewFindings[];
  summary: string;
};

export type FixResult =
  | { ok: true; head: string; closeoutReport?: string }
  | { ok: false; reason: string };

export interface FixRunner {
  applyFix(request: FixRequest): Promise<FixResult>;
}
