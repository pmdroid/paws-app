import type { DecisionDocument as SpecDecision, DecisionItem } from "../closeout-spec";
import type { DecisionDocument, GateResult, ReviewFindings } from "./types";

export function formatEvidenceSummary(
  result: Pick<
    GateResult,
    "outcome" | "taskId" | "base" | "head" | "fixAttempts" | "evaluations" | "exitCode" | "decision"
  > & {
    /** The Linear identifier, such as `PAS-367`. People read this; `taskId` stays the internal path id. */
    taskLabel?: string;
  },
): string {
  const lines = [
    `Closeout: ${result.outcome}`,
    `Task: ${result.taskLabel ?? result.taskId}`,
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
  reviewFindings: ReviewFindings[],
): string {
  const lines = [`Closeout ${decision.decision} at ${decision.head}.`];
  if (decision.message) lines.push(decision.message);
  for (const item of decision.items) {
    if (item.state === "passed" || item.state === "skipped") continue;
    lines.push(`- ${item.id} (${item.kind}): ${item.state} — ${item.message}`);
  }
  const findings = reviewFindingText(reviewFindings);
  if (findings) lines.push(findings);
  return lines.join("\n");
}

export function reviewFindingText(reviewFindings: readonly ReviewFindings[]): string {
  const { lines, omitted } = reviewFindingLines(reviewFindings);
  return [
    ...lines.map(({ itemId, line }) => `- review ${itemId} ${line}`),
    ...(omitted > 0 ? [`- ${omittedFindings(omitted)}`] : []),
  ].join("\n");
}

const FINDING_TEXT_LIMIT = 1000;
const FINDING_LINE_LIMIT = 20;

export function reviewFindingLines(reviewFindings: readonly ReviewFindings[]): {
  lines: Array<{ itemId: string; line: string }>;
  omitted: number;
} {
  const all = reviewFindings.flatMap((review) =>
    review.findings.map((finding) => {
      const old = review.preExisting?.includes(finding)
        ? " Pre-existing code the change did not edit: not required, does not block."
        : "";
      return {
        itemId: review.itemId,
        line: `${finding.severity} at ${finding.location}: ${clip(finding.explanation)} (${clip(finding.evidence)})${old}`,
      };
    }),
  );
  return {
    lines: all.slice(0, FINDING_LINE_LIMIT),
    omitted: Math.max(0, all.length - FINDING_LINE_LIMIT),
  };
}

export function omittedFindings(count: number): string {
  return `${count} more ${count === 1 ? "finding" : "findings"} not shown.`;
}

function clip(text: string): string {
  return text.length > FINDING_TEXT_LIMIT ? `${text.slice(0, FINDING_TEXT_LIMIT)}…` : text;
}

/** How a verified artifact is shown. A mismatch is not linked as the recorded bytes. */
export type ArtifactLink = {
  /** Portable path relative to the evidence root (`logs/...` or another artifact). */
  path: string;
  status: "ok" | "mismatch" | "unreadable";
};

export type RequirementLinks = {
  itemId: string;
  attempt?: number;
  artifacts: readonly ArtifactLink[];
};

/**
 * Decision text for a pull request body, a GitHub or Linear evidence comment, and the dashboard.
 * The labels match the summary the dashboard already reads. Skipped requirements are omitted.
 * Log lines are added by `renderCloseoutEvidence` after the artifact bytes are checked.
 */
export function formatCloseoutEvidence(
  decision: SpecDecision,
  links: readonly RequirementLinks[] = [],
): string {
  const lines = [
    `Closeout: ${decision.decision}`,
    `Base: ${decision.base}`,
    `Head: ${decision.head}`,
    `Policy: ${decision.policy.digest ?? "none"}`,
  ];
  if (decision.message) lines.push(`Message: ${decision.message}`);
  const shown = decision.items.filter((item) => item.state !== "skipped");
  if (shown.length === 0 && decision.items.length === 0) {
    lines.push("Items:", "- (none)");
  } else if (shown.length > 0) {
    lines.push("Items:");
    for (const item of shown) {
      const attempt = item.attempt === undefined ? "" : ` attempt ${item.attempt}`;
      lines.push(`- ${item.id} (${item.kind}): ${item.state}${attempt} — ${item.message}`);
      for (const link of linksFor(item, links)) lines.push(`  ${formatArtifactLink(link)}`);
    }
  }
  return lines.join("\n");
}

function linksFor(item: DecisionItem, links: readonly RequirementLinks[]): readonly ArtifactLink[] {
  const matched = links.filter((entry) => entry.itemId === item.id);
  if (item.attempt !== undefined) {
    return matched.find((entry) => entry.attempt === item.attempt)?.artifacts ?? [];
  }
  return matched[0]?.artifacts ?? [];
}

function formatArtifactLink(link: ArtifactLink): string {
  const label = link.path.startsWith("logs/") || link.path.length === 0 ? "log" : "artifact";
  if (link.path.length === 0) return "log: artifacts exceed 16";
  if (link.status === "mismatch") return `${label}: ${link.path} (hash mismatch)`;
  if (link.status === "unreadable") return `${label}: ${link.path} (unreadable)`;
  const href = link.path;
  return `${label}: [${href}](${href})`;
}
