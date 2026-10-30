import { bugClass } from "../closeout";
import type { StatusReviewFinding } from "../web";

const TITLE_LIMIT = 120;

/** The finding's text on one line, shortened to fit a Linear title. */
export function findingIssueTitle(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= TITLE_LIMIT ? line : `${line.slice(0, TITLE_LIMIT - 1).trimEnd()}…`;
}

/**
 * The issue body. Every text that came from the reviewer sits in a code span or a fenced
 * block, so none of it becomes a mention, an issue link or a link in Linear.
 */
export function findingIssueDescription(input: {
  finding: Pick<StatusReviewFinding, "severity" | "location" | "explanation" | "evidence">;
  reviewId: string;
  headSha: string;
  repository: string;
  /** The Paws item's Linear identifier, such as `PAS-872`. */
  identifier: string;
  /** The item's Paws issue page. */
  pageUrl: string;
}): string {
  const { finding } = input;
  return [
    `A pre-existing finding from Paws review of ${input.identifier}. The pull request did not change this code, so it did not block.`,
    [
      `- **Severity:** ${finding.severity}`,
      `- **Location:** ${codeSpan(finding.location)}`,
      `- **Class of bug:** ${codeSpan(bugClass(finding.explanation))}`,
      `- **Review:** ${codeSpan(input.reviewId)}`,
      `- **Found at:** ${codeSpan(input.headSha)} in ${codeSpan(input.repository)}`,
      `- **Paws issue:** [${input.identifier} in Paws](${input.pageUrl})`,
    ].join("\n"),
    "**Finding**",
    codeBlock(finding.explanation),
    ...(finding.evidence.trim() ? ["**Evidence**", codeBlock(finding.evidence)] : []),
  ].join("\n\n");
}

/** `text` on one line as an inline code span, fenced longer than any backtick run in it. */
function codeSpan(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  const fence = "`".repeat(longestRun(line, "`") + 1);
  const pad = line.startsWith("`") || line.endsWith("`") ? " " : "";
  return `${fence}${pad}${line}${pad}${fence}`;
}

/** `text` as a fenced block whose fence no line of `text` can close. */
function codeBlock(text: string): string {
  const fence = "`".repeat(Math.max(3, longestRun(text, "`") + 1));
  return `${fence}text\n${text.replace(/\r\n?/g, "\n").trimEnd()}\n${fence}`;
}

function longestRun(text: string, char: string): number {
  let longest = 0;
  let run = 0;
  for (const value of text) {
    run = value === char ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return longest;
}
