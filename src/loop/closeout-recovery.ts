import type { Database } from "bun:sqlite";
import { listCloseoutRecoveries, type CloseoutRecovery, type CloseoutSkip } from "../db";
import type { CloseoutBypass } from "../closeout";

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
  let retryBaseline: readonly string[] = [];
  const bypasses: CloseoutBypass[] = [];
  for (const recovery of listCloseoutRecoveries(db, itemId)) {
    if (recovery.answer === null || recovery.answeredBy === null) continue;
    const answer = parseRecoveryAnswer(recovery.answer, recovery.failedChecks);
    if (answer?.kind === "guidance") retryBaseline = recovery.retryBaseline;
    if (
      answer?.kind === "bypass" &&
      recovery.answeredBy !== "linear" &&
      recovery.answeredBy !== "unknown"
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
  return { retryBaseline, bypasses };
}

export function recoveryQuestion(
  recovery: Omit<CloseoutRecovery, "questionId" | "answer" | "answeredBy">,
  error?: string,
): string {
  return [
    "Closeout needs your help.",
    ...(error ? [error] : []),
    recovery.summary,
    ...(recovery.skip ? [skipRequestText(recovery.skip)] : []),
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

function skipRequestText(skip: CloseoutSkip): string {
  return [
    `The agent asks to skip ${skip.checkIds.join(", ")} after the last attempt failed.`,
    `Reason: ${skip.reason}`,
    ...(skip.evidence.length
      ? [
          "Evidence:",
          ...skip.evidence.map(
            (entry) => `- [${entry.label.replace(/[\\[\]]/g, "\\$&")}](<${entry.url}>)`,
          ),
        ]
      : []),
  ].join("\n");
}

/**
 * Checks the agent may ask to skip at this gate: bypassable ones whose retry budget ended
 * with a failed attempt. Checks blocked for another reason, such as reviewer independence,
 * are left out.
 */
export function skippableChecks(
  items: readonly { id: string; state: string }[],
  failedChecks: readonly string[],
): string[] {
  return items
    .filter((check) => check.state === "exhausted" && failedChecks.includes(check.id))
    .map((check) => check.id);
}

/** Requested reviews that did not fail in Paws' latest finished Closeout. */
export function unfailedReviews(
  steps: readonly { id: string; state: string }[],
  reviewIds: readonly string[],
): string[] {
  return reviewIds.filter((id) => {
    const state = steps.find((step) => step.id === id)?.state;
    return state !== "failed" && state !== "exhausted";
  });
}
