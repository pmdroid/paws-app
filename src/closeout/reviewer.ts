import type { EarlierFinding } from "../closeout-spec";
import type { CandidateIdentity, Finding } from "./types";

/**
 * Codex reviewer hook. The ACP runner implements this with `codex-acp`
 * in a different session and a different model from the implementer.
 * The gate does not spawn Codex itself.
 *
 * Independence is decided by the native decision from the identities on
 * the evidence record. An empty session or model does not satisfy a
 * `true` independence flag.
 */
export type ReviewRequest = {
  worktree: string;
  taskId: string;
  itemId: string;
  base: string;
  head: string;
  candidate: CandidateIdentity;
  prompt?: string;
  earlier?: readonly EarlierFinding[];
};

export type ReviewResult = {
  session: string;
  model: string;
  provider: string;
  findings: Finding[];
  tokens?: number;
};

export interface CodexReviewer {
  review(request: ReviewRequest): Promise<ReviewResult>;
}
