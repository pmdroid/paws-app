import type { Database } from "bun:sqlite";
import { enqueueOutboxOnceSteps, listOpenPolicyBlocksSteps, sqliteDb, type Db } from "../db";
import { journal } from "../journal";
import { answerQuestion, shortCommit } from "../questions";
import { POLICY_LOADS_ANSWER } from "./closeout-recovery";
import { retryCloseout } from "./question-effects";

export const POLICY_BLOCK_CHECK_JOB = "closeout.policy-block.check";
export const POLICY_BLOCK_CHECK_MS = 5 * 60_000;

export async function policyBlockedRepositories(
  store: Db,
): Promise<{ repository: string; itemId: string }[]> {
  const seen = new Map<string, string>();
  for (const block of await store.run((q) => listOpenPolicyBlocksSteps(q)))
    if (!seen.has(block.repository)) seen.set(block.repository, block.itemId);
  return [...seen].map(([repository, itemId]) => ({ repository, itemId }));
}

export async function retryPolicyBlocks(
  db: Database,
  input: {
    repository: string;
    main: string;
    policy: { digest: string } | { ok: false } | null;
    now: number;
  },
): Promise<string[]> {
  if (input.policy === null || "ok" in input.policy) return [];
  const answer = `${POLICY_LOADS_ANSWER} ${shortCommit(input.main)}.`;
  const answered = await sqliteDb(db).transaction(function* (q) {
    const retried: string[] = [];
    for (const block of yield* listOpenPolicyBlocksSteps(q, input.repository)) {
      const question = answerQuestion(db, block.questionId, {
        answer,
        answeredBy: "paws",
        now: input.now,
      });
      if (question === null) continue;
      retryCloseout(db, question, { now: input.now, answer });
      yield* enqueueOutboxOnceSteps(q, {
        target: "linear",
        op: "activity",
        orderingKey: question.sessionId,
        idempotencyKey: `policy-block:retried:${question.id}`,
        payload: { sessionId: question.sessionId, kind: "thought", body: answer },
        now: input.now,
      });
      retried.push(question.id);
    }
    return retried;
  });
  if (answered.length > 0)
    journal(
      `closeout policy on main of ${input.repository} loads at ${input.main}: retried ${answered.length} closeout-help questions`,
    );
  return answered;
}
