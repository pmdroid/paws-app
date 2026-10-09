import type { DecisionDocument, Finding, GateResult } from "./types";

export function formatEvidenceSummary(
  result: Pick<
    GateResult,
    "outcome" | "taskId" | "base" | "head" | "fixAttempts" | "evaluations" | "exitCode" | "decision"
  >,
): string {
  const lines = [
    `Closeout: ${result.outcome}`,
    `Task: ${result.taskId}`,
    `Base: ${result.base}`,
    `Head: ${result.head}`,
    `Fix attempts: ${result.fixAttempts}`,
    `Evaluations: ${result.evaluations}`,
    `Exit: ${result.exitCode ?? "none"}`,
  ];
  if (result.decision?.message) lines.push(`Message: ${result.decision.message}`);
  if (result.decision) {
    lines.push("Items:");
    if (result.decision.items.length === 0) lines.push("- (none)");
    for (const item of result.decision.items) {
      const attempt = item.attempt === undefined ? "" : ` attempt ${item.attempt}`;
      lines.push(`- ${item.id} (${item.kind}): ${item.state}${attempt} — ${item.message}`);
    }
  }
  return lines.join("\n");
}

export function formatFixFeedback(
  decision: DecisionDocument,
  reviewFindings: Array<{ itemId: string; findings: Finding[] }>,
): string {
  const lines = [`Closeout ${decision.decision} at ${decision.head}.`];
  if (decision.message) lines.push(decision.message);
  for (const item of decision.items) {
    if (item.state === "passed" || item.state === "skipped") continue;
    lines.push(`- ${item.id} (${item.kind}): ${item.state} — ${item.message}`);
  }
  for (const review of reviewFindings) {
    for (const finding of review.findings) {
      lines.push(
        `- review ${review.itemId} ${finding.severity} at ${finding.location}: ${finding.explanation} (${finding.evidence})`,
      );
    }
  }
  return lines.join("\n");
}
