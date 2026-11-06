import type { Database } from "bun:sqlite";
import { enqueueOutboxOnce, immediate, listOpenPolicyBlocks } from "../db";
import { journal } from "../journal";
import { answerQuestion, shortCommit } from "../questions";
import { POLICY_LOADS_ANSWER } from "./closeout-recovery";
import { retryCloseout } from "./question-effects";

export const POLICY_BLOCK_CHECK_JOB = "closeout.policy-block.check";
export const POLICY_BLOCK_CHECK_MS = 5 * 60_000;

export function policyBlockedRepositories(db: Database): { repository: string; itemId: string }[] {
  const seen = new Map<string, string>();
  for (const block of listOpenPolicyBlocks(db))
    if (!seen.has(block.repository)) seen.set(block.repository, block.itemId);
  return [...seen].map(([repository, itemId]) => ({ repository, itemId }));
}

export function retryPolicyBlocks(
  db: Database,
  input: {
    repository: string;
    main: string;
    policy: { digest: string } | { ok: false } | null;
    now: number;
  },
): string[] {
  if (input.policy === null || "ok" in input.policy) return [];
  const answer = `${POLICY_LOADS_ANSWER} ${shortCommit(input.main)}.`;
  const answered = immediate(db, () =>
    listOpenPolicyBlocks(db, input.repository).flatMap((block) => {
      const question = answerQuestion(db, block.questionId, {
        answer,
        answeredBy: "paws",
        now: input.now,
      });
      if (question === null) return [];
      retryCloseout(db, question, { now: input.now, answer });
      enqueueOutboxOnce(db, {
        target: "linear",
        op: "activity",
        orderingKey: question.sessionId,
        idempotencyKey: `policy-block:retried:${question.id}`,
        payload: { sessionId: question.sessionId, kind: "thought", body: answer },
        now: input.now,
      });
      return [question.id];
    }),
  );
  if (answered.length > 0)
    journal(
      `closeout policy on main of ${input.repository} loads at ${input.main}: retried ${answered.length} closeout-help questions`,
    );
  return answered;
}
