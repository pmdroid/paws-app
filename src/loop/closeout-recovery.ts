import type { Database } from "bun:sqlite";
import {
  getLinkAsk,
  humanRetryBaseline,
  listCloseoutBypassChecks,
  listCloseoutRecoveries,
  type CloseoutRecovery,
} from "../db";
import type { CloseoutBypass } from "../closeout";

/** A reply that tries to bypass a check, such as `/paws bypass lint -- reason`. It is guidance now. */
export const BYPASS_REPLY = /^\s*\/?(?:paws\s+)?bypass\b/i;

export function recoveryOptions(
  db: Database,
  itemId: string,
): { retryBaseline: readonly string[]; bypasses: CloseoutBypass[] } {
  const retryBaseline = new Set<string>(humanRetryBaseline(db, itemId));
  const bypasses: CloseoutBypass[] = [];
  // Only a person authorizes fresh check attempts or a bypass. Rebases retain failures.
  for (const recovery of listCloseoutRecoveries(db, itemId)) {
    const linkAsk = getLinkAsk(db, recovery.questionId);
    if (linkAsk === null) {
      // A reply in Linear is guidance, whatever it says. It never bypasses a check.
      if (recovery.answer !== null && recovery.answeredBy !== null)
        for (const key of recovery.retryBaseline) retryBaseline.add(key);
      continue;
    }
    if (linkAsk.decision === "changes" || linkAsk.closedReason === "guidance")
      for (const key of recovery.retryBaseline) retryBaseline.add(key);
    if (linkAsk.decision !== "approve") continue;
    // Bypasses are approved on the item page, one reason per check.
    for (const check of listCloseoutBypassChecks(db, recovery.questionId))
      if (check.approvedBy !== null && check.reason !== null)
        bypasses.push({
          questionId: recovery.questionId,
          taskId: recovery.taskId,
          base: recovery.base,
          head: recovery.head,
          policyDigest: recovery.policyDigest,
          checkIds: [check.checkId],
          actor: check.approvedBy,
          ...(check.approvedByName ? { actorName: check.approvedByName } : {}),
          reason: check.reason,
        });
  }
  return { retryBaseline: [...retryBaseline], bypasses };
}

/** Starts the summary of a preparation that kept failing before the agent started. */
export const PREPARATION_FAILED = "Agent preparation failed";

export function recoveryQuestion(
  recovery: Omit<CloseoutRecovery, "questionId" | "answer" | "answeredBy">,
  error?: string,
): string {
  const unsupported =
    /\.ya?ml: \S* ?must NOT have additional properties \('([^']+)' was unexpected\)/.exec(
      recovery.summary,
    )?.[1];
  if (recovery.summary.startsWith(PREPARATION_FAILED))
    return [
      "Agent preparation needs your help.",
      ...(error ? [error] : []),
      recovery.summary,
      "Paws could not prepare the agent before it started, so there is no candidate to verify yet.",
      "Reply retry or with guidance to start the task again on its configured agent.",
    ].join("\n\n");
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
          `A failed check (${recovery.failedChecks.join(", ")}) is bypassed only on the item page in Paws, which needs PAWS_PUBLIC_URL. A reply here cannot bypass a check.`,
        ]
      : []),
  ].join("\n\n");
}
