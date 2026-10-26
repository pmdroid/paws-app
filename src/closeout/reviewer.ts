import type { ProducerIdentity } from "../closeout-spec";
import { createReviewer } from "../closeout-spec";
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

/**
 * One turn of the reviewer ACP session.
 * `fresh` is true for the first prompt. A re-ask sets `sessionId` and `fresh` false.
 * `checkpoint` stays false so the read-only checkout is left uncommitted.
 */
export type CodexAcpStart = {
  role: "reviewer";
  itemId: string;
  worktree: string;
  prompt: string;
  readOnly: true;
  checkpoint: false;
  fresh: boolean;
  sessionId?: string;
};

export type CodexAcpReply = {
  sessionId?: string;
  /** Model id reported by the agent, when it reports one. */
  model?: string;
  text: string;
};

/** Existing ACP runner seam, narrowed to a fresh Codex reviewer session. */
export interface CodexAcpRunner {
  start(input: CodexAcpStart): Promise<CodexAcpReply>;
}

export type CodexReviewerOptions = {
  /** Configured model id, used when the session does not report one. */
  model: string;
  evaluator?: ProducerIdentity;
  attempt?: number;
  diffBudget?: number;
};

/**
 * Native Closeout reviewer on the Codex ACP hook.
 * The runner opens the session. Findings, identity, and the re-ask live on the port.
 * The evaluator computes independence from the candidate and the producer.
 */
export function createCodexReviewer(runner: CodexAcpRunner, options: CodexReviewerOptions) {
  return createReviewer(
    {
      async run(input) {
        const reply = await runner.start({
          role: "reviewer",
          itemId: input.itemId,
          worktree: input.worktree,
          prompt: input.prompt,
          readOnly: true,
          checkpoint: false,
          fresh: input.sessionId === undefined,
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        });
        const reported = reply.model?.trim();
        return {
          sessionId: reply.sessionId ?? "",
          ...(reported ? { model: reported } : {}),
          text: reply.text,
        };
      },
    },
    options,
  );
}
