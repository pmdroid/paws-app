import type { Database } from "bun:sqlite";
import { listCloseoutRecoveries, listCloseoutRounds, type CloseoutRecovery } from "../db";
import type { CloseoutBypass } from "../closeout";
import { canAnswer } from "../questions";

export type RecoveryAnswer =
  | { kind: "guidance"; body: string }
  | { kind: "bypass"; checkIds: string[]; reason: string };

export function parseRecoveryAnswer(
  answer: string,
  failedChecks: readonly string[],
): RecoveryAnswer | null {
  if (!/^\/?(?:paws\s+)?bypass\b/i.test(answer)) return { kind: "guidance", body: answer };
  const match = /^\/paws bypass ([a-z0-9/, -]+) -- (\S[\s\S]*)$/i.exec(answer.trim());
  if (!match) return null;
  const checkIds = [...new Set((match[1] ?? "").split(/[\s,]+/).filter(Boolean))];
  const reason = match[2]?.trim() ?? "";
  if (!checkIds.length || !reason || checkIds.some((id) => !failedChecks.includes(id))) return null;
  return { kind: "bypass", checkIds, reason };
}

export function recoveryOptions(
  db: Database,
  itemId: string,
): { retryBaseline: readonly string[]; bypasses: CloseoutBypass[] } {
  const retryBaseline = new Set<string>();
  const bypasses: CloseoutBypass[] = [];
  // Evidence only grows, so the union is the newest snapshot: a guidance
  // answer or a rebased head (closeout_round) each start a fresh budget.
  for (const round of listCloseoutRounds(db, itemId))
    for (const key of round.retryBaseline) retryBaseline.add(key);
  for (const recovery of listCloseoutRecoveries(db, itemId)) {
    if (recovery.answer === null || recovery.answeredBy === null) continue;
    const answer = parseRecoveryAnswer(recovery.answer, recovery.failedChecks);
    if (answer?.kind === "guidance")
      for (const key of recovery.retryBaseline) retryBaseline.add(key);
    if (
      answer?.kind === "bypass" &&
      canAnswer({ kind: "closeout-bypass" }, { id: recovery.answeredBy })
    )
      bypasses.push({
        questionId: recovery.questionId,
        taskId: recovery.taskId,
        base: recovery.base,
        head: recovery.head,
        policyDigest: recovery.policyDigest,
        checkIds: answer.checkIds,
        actor: recovery.answeredBy,
        reason: answer.reason,
      });
  }
  return { retryBaseline: [...retryBaseline], bypasses };
}

export function recoveryQuestion(
  recovery: Omit<CloseoutRecovery, "questionId" | "answer" | "answeredBy">,
  error?: string,
): string {
  const unsupported =
    /\.ya?ml: \S* ?must NOT have additional properties \('([^']+)' was unexpected\)/.exec(
      recovery.summary,
    )?.[1];
  return [
    "Closeout needs your help.",
    ...(unsupported
      ? [
          `The Closeout policy on origin/main uses \`${unsupported}\`, which this version of Paws does not support. Update Paws, then reply retry.`,
        ]
      : []),
    ...(error ? [error] : []),
    recovery.summary,
    `Base: ${recovery.base}. Head: ${recovery.head}. Policy: ${recovery.policyDigest || "unavailable"}.`,
    "Reply with guidance to send the task back to its configured agent and authorize a new round with the same Closeout retry limit.",
    ...(recovery.failedChecks.length
      ? [
          `Checks you can bypass for this exact candidate: ${recovery.failedChecks.join(", ")}.`,
          "To approve selected checks, reply /paws bypass check-id,other-check-id -- your reason.",
        ]
      : []),
  ].join("\n\n");
}
