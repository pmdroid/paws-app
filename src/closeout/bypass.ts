import type { Evaluation } from "./run";

export type CloseoutBypass = {
  questionId: string;
  taskId: string;
  base: string;
  head: string;
  policyDigest: string;
  checkIds: readonly string[];
  /** Linear user id of the person who approved the bypass. */
  actor: string;
  /** Their name as Paws shows it, for the pull request body. */
  actorName?: string;
  reason: string;
};

export function bypassable(state: string): boolean {
  return state === "failed" || state === "exhausted" || state === "independence";
}

export function applyBypasses(
  evaluation: Evaluation,
  approvals: readonly CloseoutBypass[],
): Evaluation {
  const decision = evaluation.decision;
  if (!decision || !decision.policy.digest || evaluation.outcome === "invalid") return evaluation;
  const used = approvals.filter(
    (approval) =>
      approval.taskId === decision.candidate.task &&
      approval.base === decision.base &&
      approval.head === decision.head &&
      approval.policyDigest === decision.policy.digest &&
      approval.actor.trim() !== "" &&
      approval.reason.trim() !== "" &&
      approval.checkIds.length > 0 &&
      approval.checkIds.every((id) =>
        decision.items.some(
          (item) =>
            item.id === id &&
            (bypassable(item.state) || item.state === "passed" || item.state === "skipped"),
        ),
      ),
  );
  if (used.length === 0) return evaluation;
  const ids = new Set(used.flatMap((approval) => [...approval.checkIds]));
  const remaining = decision.items.filter(
    (item) =>
      item.state !== "passed" &&
      (item.state !== "skipped" || item.message === "setup failed") &&
      !ids.has(item.id),
  );
  const outcome =
    remaining.length === 0
      ? "accepted"
      : remaining.some((item) => item.state === "exhausted")
        ? "exhausted"
        : remaining.every((item) => item.state === "failed")
          ? "rejected"
          : "blocked";
  return { ...evaluation, outcome, bypasses: used };
}

/** The pull request body's list of bypassed checks: each check, its reason and who approved it. */
export function bypassSummary(approvals: readonly CloseoutBypass[]): string {
  const flat = (text: string) => text.replace(/\s+/g, " ").trim();
  return [
    "Bypassed checks:",
    ...approvals.flatMap((approval) =>
      approval.checkIds.map(
        (id) =>
          `- ${id}: ${flat(approval.reason)} — approved by ${flat(approval.actorName || approval.actor)} in Paws for head ${approval.head} and policy ${approval.policyDigest} (question ${approval.questionId}).`,
      ),
    ),
  ].join("\n");
}
