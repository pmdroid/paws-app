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
};

/**
 * Runs the pinned `closeout` runner in the worktree.
 * Command items and the Codex review item are QM-06; this module only owns the gate seam.
 */
export interface CloseoutGate {
  run(input: CloseoutRunInput): Promise<CloseoutVerdict>;
}
