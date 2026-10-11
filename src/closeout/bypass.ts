import type { Evaluation } from "./run";

export type CloseoutBypass = {
  questionId: string;
  taskId: string;
  base: string;
  head: string;
  policyDigest: string;
  checkIds: readonly string[];
  actor: string;
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

export function bypassSummary(approvals: readonly CloseoutBypass[]): string {
  return approvals
    .map(
      (approval) =>
        `Human bypass: ${approval.checkIds.join(", ")} approved by ${approval.actor}. Reason: ${approval.reason}. Approval question: ${approval.questionId}. Base: ${approval.base}. Head: ${approval.head}. Policy: ${approval.policyDigest}.`,
    )
    .join("\n");
}
