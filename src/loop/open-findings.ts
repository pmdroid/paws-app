import type { Database } from "bun:sqlite";
import { reviewRecordsAt, type Finding } from "../closeout";
import { riskLine, type RiskClassification } from "../core";
import { acceptedCloseoutReviews, type WorkItemRecord } from "../db";

const SEVERITIES: readonly Finding["severity"][] = ["P0", "P1", "P2", "P3"];

/** A finding text longer than this is cut, so each finding stays one line. */
const TEXT_LIMIT = 160;

/** A review finding that did not block the accepted head. */
export type OpenFinding = {
  reviewId: string;
  severity: Finding["severity"];
  location: string;
  explanation: string;
  /** In code the change did not touch, or reported only because it is below the review's `failOn`. */
  why: "pre-existing" | "below failOn";
};

/** What is still open at an accepted head, and where a person checks it. */
export type OpenItems = {
  findings: readonly OpenFinding[];
  risk: RiskClassification | null;
  /** The item's Paws issue page, or null without a public dashboard URL. */
  link: string | null;
};

/**
 * The non-blocking review findings of the item's accepted head: the latest accepted Closeout run
 * on `head`, or the last accepted one when `head` was not evaluated itself. Each review's latest
 * round at that head counts. A finding that met `failOn` in changed code is not listed: Closeout
 * accepted the head only because something waived it.
 */
export async function openFindings(
  db: Database,
  item: WorkItemRecord,
  head: string | null,
  pawsRoot: string,
): Promise<OpenFinding[]> {
  const accepted = acceptedCloseoutReviews(db, item.id, head);
  if (accepted === null || accepted.reviews.length === 0) return [];
  const records = await reviewRecordsAt(accepted.taskId, accepted.head, pawsRoot);
  return accepted.reviews.flatMap((review) => {
    const record = records
      .filter((entry) => entry.itemId === review.id && entry.attempt === review.attempt)
      .at(-1);
    if (record === undefined) return [];
    const preExisting = new Set(review.preExisting ?? []);
    return record.findings.flatMap((finding, index): OpenFinding[] => {
      const why = preExisting.has(index)
        ? "pre-existing"
        : review.failOn === null ||
            review.failOn === undefined ||
            !meets(finding.severity, review.failOn)
          ? "below failOn"
          : null;
      if (why === null) return [];
      return [
        {
          reviewId: review.id,
          severity: finding.severity,
          location: finding.location,
          explanation: finding.explanation,
          why,
        },
      ];
    });
  });
}

/** `<publicUrl>/status/issues/<identifier>`, or null without a public URL. */
export function pawsIssueUrl(
  publicUrl: string | null | undefined,
  item: WorkItemRecord,
): string | null {
  const base = publicUrl?.trim().replace(/\/+$/, "");
  if (!base) return null;
  return `${base}/status/issues/${encodeURIComponent(item.linearIdentifier ?? item.id)}`;
}

/**
 * "2 findings still open (1 P1 pre-existing, 1 P2 below failOn) and risk high (`a.ts`). Check
 * them: <link>". Empty when no finding is open and the risk is not high.
 */
export function openFindingsLine(open: OpenItems): string {
  const high = open.risk?.tier === "high";
  if (open.findings.length === 0 && !high) return "";
  const risk = high ? `risk high (${riskLine(open.risk).replace(/^Risk: high — /, "")})` : "";
  const counts = new Map<string, number>();
  for (const finding of sorted(open.findings)) {
    const key = `${finding.severity} ${finding.why}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const count = open.findings.length;
  const findings = `${count} finding${count === 1 ? "" : "s"} still open (${[...counts]
    .map(([key, n]) => `${n} ${key}`)
    .join(", ")})`;
  const lead =
    count === 0
      ? `No findings still open, and ${risk}.`
      : `${findings}${high ? ` and ${risk}` : ""}.`;
  return open.link
    ? `${lead} Check them: ${open.link}`
    : `${lead} Check them on the Paws dashboard.`;
}

/** The pull request's `## Open findings` section: the line and one line per finding. */
export function openFindingsSection(open: OpenItems): string {
  const line = openFindingsLine(open);
  if (line === "") return "";
  return ["## Open findings", line, sorted(open.findings).map(findingLine).join("\n")]
    .filter(Boolean)
    .join("\n\n");
}

/** "- P1 `src/a.ts:12` Text cut to one line (independent-review, pre-existing)" */
function findingLine(finding: OpenFinding): string {
  const text = oneLine(finding.explanation);
  return `- ${finding.severity} ${codeSpan(oneLine(finding.location))}${text ? ` ${inertMarkdown(text)}` : ""} (${inertMarkdown(finding.reviewId)}, ${finding.why})`;
}

/**
 * Model text made inert in GitHub and Linear Markdown: no emphasis, link, image, HTML, entity,
 * mention, issue reference or bare URL that the text spells out renders as one.
 */
export function inertMarkdown(text: string): string {
  return text
    .replace(/[\\`*_[\]<>|~&!]/g, "\\$&")
    .replace(/@/g, "@⁠")
    .replace(/#(?=\w)/g, "#⁠")
    .replace(/:\/\//g, ":⁠//")
    .replace(/\bwww\./gi, (match) => `${match.slice(0, 3)}⁠.`);
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > TEXT_LIMIT ? `${flat.slice(0, TEXT_LIMIT - 1).trimEnd()}…` : flat;
}

function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

function sorted(findings: readonly OpenFinding[]): OpenFinding[] {
  return [...findings].sort(
    (left, right) =>
      SEVERITIES.indexOf(left.severity) - SEVERITIES.indexOf(right.severity) ||
      (left.why === right.why ? 0 : left.why === "pre-existing" ? -1 : 1),
  );
}

function meets(severity: Finding["severity"], failOn: Finding["severity"]): boolean {
  return SEVERITIES.indexOf(severity) <= SEVERITIES.indexOf(failOn);
}
