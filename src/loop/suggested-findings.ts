import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { JOB_KIND } from "../core";
import {
  decideSuggestedFindings,
  getSuggestionTurn,
  getWorkItem,
  immediate,
  pendingChangeRequests,
  pendingLinearComments,
  pendingPullCiFailures,
  pendingPullComments,
  recordSuggestedFindings,
  recordSuggestionTurn,
  suggestedFindings,
  type SuggestedFindingRecord,
  type WorkItemRecord,
} from "../db";
import { openFindings, type OpenFinding } from "./open-findings";
import type { SuggestedFindingLine } from "../acp";
import { restart } from "./operations";
import { SUGGESTION_TURN_HANDOFF } from "./pull-comments";
import { parseFindingDecisions } from "./review-replies";

const SEVERITIES: readonly OpenFinding["severity"][] = ["P0", "P1", "P2", "P3"];

export const SUGGESTION_TURN_MIN_AWAKE_MS = 45 * 60_000;

export function findingId(finding: Pick<OpenFinding, "reviewId" | "location" | "explanation">) {
  const digest = createHash("sha256")
    .update(`${finding.reviewId}\0${finding.location}\0${finding.explanation}`)
    .digest("hex");
  return `F${digest.slice(0, 6)}`;
}

export function suggestionTurnJobKey(itemId: string): string {
  return `suggested-findings:${itemId}`;
}

export async function acceptedSuggestions(
  db: Database,
  item: WorkItemRecord,
  pawsRoot: string,
): Promise<OpenFinding[]> {
  if (item.acceptedHead === null) return [];
  const findings = await openFindings(db, item, item.acceptedHead, pawsRoot);
  return withDecisions(
    findings.filter((finding) => finding.why === "below failOn"),
    suggestedFindings(db, item.id),
  );
}

export function withDecisions(
  findings: readonly OpenFinding[],
  records: readonly SuggestedFindingRecord[],
): OpenFinding[] {
  const decided = records.filter((record) => record.decision !== null);
  const shown = new Set<SuggestedFindingRecord>();
  const listed = findings.map((finding) => {
    if (finding.why !== "below failOn") return finding;
    const id = findingId(finding);
    const record = decided.find((entry) => entry.findingId === id);
    if (!record) return finding;
    shown.add(record);
    return { ...finding, decision: decisionOf(record) };
  });
  const omitted = decided
    .filter((record) => !shown.has(record))
    .flatMap((record): OpenFinding[] => {
      const severity = SEVERITIES.find((level) => level === record.severity);
      return severity
        ? [
            {
              reviewId: record.reviewId,
              severity,
              location: record.location,
              explanation: record.explanation,
              why: "below failOn",
              decision: decisionOf(record),
            },
          ]
        : [];
    });
  return [...listed, ...omitted];
}

function decisionOf(record: SuggestedFindingRecord): NonNullable<OpenFinding["decision"]> {
  return { decision: record.decision!, reason: record.reason ?? "", head: record.head };
}

export function undecidedSuggestions(findings: readonly OpenFinding[]): OpenFinding[] {
  return findings.filter((finding) => finding.why === "below failOn" && !finding.decision);
}

export function handSuggestions(
  db: Database,
  itemId: string,
  findings: readonly OpenFinding[],
  now: number,
): void {
  recordSuggestedFindings(
    db,
    itemId,
    findings.map((finding) => ({
      findingId: findingId(finding),
      reviewId: finding.reviewId,
      location: finding.location,
      severity: finding.severity,
      explanation: finding.explanation,
    })),
    now,
  );
}

export function recordAgentFindingDecisions(
  db: Database,
  itemId: string,
  finalMessage: string,
  fixCommit: string | null,
  now: number,
): number {
  const waiting = new Set(
    suggestedFindings(db, itemId)
      .filter((record) => record.decision === null)
      .map((record) => record.findingId),
  );
  if (waiting.size === 0) return 0;
  const decisions = parseFindingDecisions(finalMessage, waiting);
  if (fixCommit === null)
    for (const [id, report] of decisions) if (report.decision === "fixed") decisions.delete(id);
  return decideSuggestedFindings(db, itemId, decisions, fixCommit, now);
}

export function waitingSuggestions(db: Database, itemId: string): SuggestedFindingLine[] {
  return suggestedFindings(db, itemId)
    .filter((record) => record.decision === null)
    .map((record) => ({
      id: record.findingId,
      severity: record.severity,
      location: record.location,
      explanation: record.explanation,
      reviewId: record.reviewId,
    }));
}

export function suggestionTurnRunning(db: Database, itemId: string): number | null {
  return (
    db
      .query<{ id: number }, [string, string]>(
        `SELECT id FROM job WHERE queue = ? AND job_key = ? AND status = 'running'`,
      )
      .get(JOB_KIND.resume, suggestionTurnJobKey(itemId))?.id ?? null
  );
}

function restartComing(db: Database, itemId: string): boolean {
  const queued = db
    .query<{ n: number }, [string, string, string]>(
      `SELECT count(*) AS n FROM job WHERE queue IN (?, ?) AND status = 'pending'
       AND json_extract(payload, '$.itemId') = ?`,
    )
    .get(JOB_KIND.start, JOB_KIND.resume, itemId);
  return (
    (queued?.n ?? 0) > 0 ||
    pendingPullComments(db, itemId).length > 0 ||
    pendingChangeRequests(db, itemId).length > 0 ||
    pendingPullCiFailures(db, itemId).length > 0 ||
    pendingLinearComments(db, itemId).length > 0
  );
}

export type SuggestionTurn = "started" | "skipped" | "none";

export function startSuggestionTurn(
  db: Database,
  input: { itemId: string; head: string; suggestions: number; now: number },
): SuggestionTurn {
  return immediate(db, (): SuggestionTurn => {
    const item = getWorkItem(db, input.itemId);
    if (!item || item.state !== "merge_queue" || item.cancelRequested) return "none";
    if (input.suggestions === 0 || getSuggestionTurn(db, item.id) !== null) return "none";
    if (restartComing(db, item.id)) {
      recordSuggestionTurn(db, {
        itemId: item.id,
        outcome: "skipped",
        reason: "Another restart was already coming; it carries the suggestions.",
        head: input.head,
        recordedAt: input.now,
      });
      return "skipped";
    }
    const remaining = item.maxAwakeMs - item.awakeMs;
    if (remaining < SUGGESTION_TURN_MIN_AWAKE_MS) {
      recordSuggestionTurn(db, {
        itemId: item.id,
        outcome: "skipped",
        reason: `${Math.max(0, Math.floor(remaining / 60_000))} minutes of the awake budget remain, under 45; the next turn carries the suggestions.`,
        head: input.head,
        recordedAt: input.now,
      });
      return "skipped";
    }
    const jobId = restart(db, item, {
      reason: "review",
      body: SUGGESTION_TURN_HANDOFF,
      jobKey: suggestionTurnJobKey(item.id),
      now: input.now,
    });
    if (jobId === null) return "none";
    recordSuggestionTurn(db, {
      itemId: item.id,
      outcome: "started",
      reason: null,
      head: input.head,
      recordedAt: input.now,
    });
    return "started";
  });
}
