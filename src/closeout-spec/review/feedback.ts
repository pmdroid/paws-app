import type {
  DecisionDocument,
  DecisionItem,
  EvidenceRecord,
  Finding,
  ItemState,
  Severity,
} from "../types";

/** Last lines of a command log included in fix feedback. */
export const LOG_TAIL_LINES = 80;

const SEVERITY_RANK: Record<Severity, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/**
 * Item states the implementer cannot repair by editing the candidate.
 * The evaluator already classified them. Feedback only reports them.
 */
const UNFIXABLE: ReadonlySet<ItemState> = new Set([
  "exhausted",
  "unsupported",
  "missing",
  "stale",
  "invalid",
  "untrusted",
  "independence",
]);

export type FeedbackRecord = {
  record: EvidenceRecord;
  /** Policy `failOn` for a review item. Findings at this rank or worse are included. */
  failOn?: Severity;
  /** Full command log. The prompt keeps the last {@link LOG_TAIL_LINES} lines. */
  log?: string;
};

/**
 * Prompt the implementer can apply after a rejected or blocked decision.
 * Failed commands and findings at or above `failOn` are the fix list.
 * Blocked reasons are stated as items the implementer cannot fix.
 */
export function formatFixFeedback(
  decision: DecisionDocument,
  records: readonly FeedbackRecord[],
): string {
  const lines = [
    `Closeout ${decision.decision} at ${decision.head}.`,
    "Fix each failed command and each finding at or above failOn.",
    "When an item is blocked, you cannot fix it.",
  ];
  if (decision.message) lines.push(decision.message);
  for (const item of decision.items) {
    if (item.state === "passed" || item.state === "skipped") continue;
    lines.push("");
    lines.push(...linesFor(item, recordFor(item, records)));
  }
  return lines.join("\n");
}

export function meetsFailOn(severity: Severity, failOn: Severity): boolean {
  return SEVERITY_RANK[severity] <= SEVERITY_RANK[failOn];
}

export function tailLogLines(log: string, count = LOG_TAIL_LINES): string {
  const lines = log.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-count).join("\n");
}

function linesFor(item: DecisionItem, source: FeedbackRecord | undefined): string[] {
  if (UNFIXABLE.has(item.state)) {
    return [
      `## ${item.id} (${item.kind}) blocked`,
      `You cannot fix this. Blocked reason: ${item.state}.`,
      item.message,
    ];
  }
  if (item.kind === "command") return commandLines(item, source);
  if (item.kind === "review") return reviewLines(item, source);
  return [`## ${item.id} (${item.kind}) ${item.state}`, item.message];
}

function commandLines(item: DecisionItem, source: FeedbackRecord | undefined): string[] {
  const lines = [`## ${item.id} (command) failed`, item.message];
  const record = source?.record;
  if (!record || record.recordType !== "command") {
    lines.push("No command record was attached.");
    return lines;
  }
  lines.push(`argv: ${JSON.stringify(record.exec.argv)}`);
  lines.push(`exit: ${record.exec.exitCode === null ? "none" : String(record.exec.exitCode)}`);
  lines.push("last 80 log lines:");
  lines.push(source.log === undefined ? "(no log)" : tailLogLines(source.log));
  return lines;
}

function reviewLines(item: DecisionItem, source: FeedbackRecord | undefined): string[] {
  const failOn = source?.failOn;
  const lines = [
    `## ${item.id} (review) failed`,
    failOn ? `failOn: ${failOn}` : "failOn: unknown",
    item.message,
  ];
  const record = source?.record;
  if (!record || record.recordType !== "review") {
    lines.push("No review record was attached.");
    return lines;
  }
  const findings = failOn
    ? record.findings.filter((finding) => meetsFailOn(finding.severity, failOn))
    : record.findings;
  if (findings.length === 0) {
    lines.push("No finding at or above failOn.");
    return lines;
  }
  for (const finding of findings) lines.push(...findingLines(finding));
  return lines;
}

function findingLines(finding: Finding): string[] {
  return [
    `- ${finding.severity}`,
    `  location: ${finding.location}`,
    `  explanation: ${finding.explanation}`,
    `  evidence: ${finding.evidence}`,
  ];
}

function recordFor(
  item: DecisionItem,
  records: readonly FeedbackRecord[],
): FeedbackRecord | undefined {
  const matches = records.filter((entry) => entry.record.itemId === item.id);
  if (item.attempt !== undefined) {
    const exact = matches.find((entry) => entry.record.attempt === item.attempt);
    if (exact) return exact;
  }
  return matches.sort((left, right) => right.record.attempt - left.record.attempt)[0];
}
