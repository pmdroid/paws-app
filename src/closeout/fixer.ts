import type { CloseoutItem, Finding } from "./types";

/**
 * Fix feedback hook. The ACP runner implements this: it resumes the
 * implementer session (or starts a fresh one) with {@link FixRequest.summary}
 * and the failed items, then commits in the worktree.
 */
export type FixRequest = {
  worktree: string;
  taskId: string;
  /** 1-based. The gate stops after {@link maxFixAttempts} calls. */
  fixAttempt: number;
  maxFixAttempts: number;
  base: string;
  head: string;
  items: CloseoutItem[];
  reviewFindings: Array<{ itemId: string; findings: Finding[] }>;
  summary: string;
};

export type FixResult =
  | { ok: true; head: string; closeoutReport?: string }
  | { ok: false; reason: string };

export interface FixRunner {
  applyFix(request: FixRequest): Promise<FixResult>;
}
