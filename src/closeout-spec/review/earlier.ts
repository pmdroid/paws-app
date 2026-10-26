import type { EarlierFinding, EvidenceRecord, ReviewRecord } from "../types";

/** Earlier findings listed in one prompt. The newest round comes first. */
export const EARLIER_FINDINGS_LIMIT = 50;

const EXPLANATION_LIMIT = 400;

/**
 * Findings from this item's earlier review rounds, newest round first.
 *
 * A round is one review record of the same item and policy, for the same task
 * (or the same base without a task), other than the one about to be written.
 * `order` places a head in history; a larger number is later. Findings from
 * the latest earlier round are `open`: the fixer was asked to fix them and
 * this round checks. An older finding the latest round did not report again
 * is `fixed`. A location reported in more than one round is listed once.
 */
export function earlierFindings(
  records: readonly EvidenceRecord[],
  scope: { itemId: string; policyDigest: string; base: string; task?: string },
  order: (head: string) => number,
): EarlierFinding[] {
  const rounds = records
    .filter((record): record is ReviewRecord => record.recordType === "review")
    .filter(
      (record) =>
        record.itemId === scope.itemId &&
        record.policyDigest === scope.policyDigest &&
        (scope.task === undefined ? record.base === scope.base : record.task === scope.task),
    )
    .sort((left, right) => order(right.head) - order(left.head) || right.attempt - left.attempt);
  const seen = new Set<string>();
  const listed: EarlierFinding[] = [];
  rounds.forEach((record, index) => {
    for (const finding of record.findings) {
      const key = finding.location.trim();
      if (seen.has(key)) continue;
      seen.add(key);
      listed.push({
        severity: finding.severity,
        location: finding.location,
        explanation: clip(finding.explanation),
        head: record.head,
        status: index === 0 ? "open" : "fixed",
      });
    }
  });
  return listed.slice(0, EARLIER_FINDINGS_LIMIT);
}

/** Prompt section for the second and later rounds. Empty for the first round. */
export function renderEarlierFindings(earlier: readonly EarlierFinding[]): string[] {
  if (earlier.length === 0) return [];
  return [
    "# Earlier findings",
    "Earlier review rounds of this item reported these findings. An open finding was reported in the last round and the fixer has changed the code since. A fixed finding was not reported again in a later round.",
    "Do not report an earlier finding again unless the problem is still present at this head. When an open finding is still present, report it again with its current path:line. Report new problems as usual.",
    ...earlier.map(
      (entry) =>
        `- ${entry.status}, ${entry.severity} at ${entry.location} (head ${entry.head.slice(0, 12)}): ${entry.explanation}`,
    ),
  ];
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= EXPLANATION_LIMIT ? flat : `${flat.slice(0, EXPLANATION_LIMIT - 1)}…`;
}
