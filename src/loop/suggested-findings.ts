import { createHash } from "node:crypto";
import { JOB_KIND } from "../core";
import {
  latestItemJobIdSteps,
  runningJobIdSteps,
  decideSuggestedFindingsSteps,
  emitJobReady,
  getSuggestionTurnSteps,
  getWorkItemSteps,
  pendingChangeRequestsSteps,
  pendingLinearCommentsSteps,
  pendingPullCiFailuresSteps,
  pendingPullCommentsSteps,
  recordSuggestedFindingsSteps,
  recordSuggestionTurnSteps,
  suggestedFindingsSteps,
  type Db,
  type Q,
  type Steps,
  type SuggestedFindingRecord,
  type WorkItemRecord,
} from "../db";
import { openFindings, type OpenFinding } from "./open-findings";
import type { SuggestedFindingLine } from "../acp";
import { restartSteps } from "./operations";
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
  store: Db,
  item: WorkItemRecord,
  pawsRoot: string,
): Promise<OpenFinding[]> {
  if (item.acceptedHead === null) return [];
  const findings = await openFindings(store, item, item.acceptedHead, pawsRoot);
  return withDecisions(
    findings.filter((finding) => finding.why === "below failOn"),
    await store.run((q) => suggestedFindingsSteps(q, item.id)),
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

export async function handSuggestions(
  store: Db,
  itemId: string,
  findings: readonly OpenFinding[],
  now: number,
): Promise<void> {
  const handed = findings.map((finding) => ({
    findingId: findingId(finding),
    reviewId: finding.reviewId,
    location: finding.location,
    severity: finding.severity,
    explanation: finding.explanation,
  }));
  await store.run((q) => recordSuggestedFindingsSteps(q, itemId, handed, now));
}

export async function recordAgentFindingDecisions(
  store: Db,
  itemId: string,
  finalMessage: string,
  fixCommit: string | null,
  now: number,
): Promise<number> {
  const waiting = new Set(
    (await store.run((q) => suggestedFindingsSteps(q, itemId)))
      .filter((record) => record.decision === null)
      .map((record) => record.findingId),
  );
  if (waiting.size === 0) return 0;
  const decisions = parseFindingDecisions(finalMessage, waiting);
  if (fixCommit === null)
    for (const [id, report] of decisions) if (report.decision === "fixed") decisions.delete(id);
  return await store.run((q) => decideSuggestedFindingsSteps(q, itemId, decisions, fixCommit, now));
}

export async function waitingSuggestions(
  store: Db,
  itemId: string,
): Promise<SuggestedFindingLine[]> {
  return (await store.run((q) => suggestedFindingsSteps(q, itemId)))
    .filter((record) => record.decision === null)
    .map((record) => ({
      id: record.findingId,
      severity: record.severity,
      location: record.location,
      explanation: record.explanation,
      reviewId: record.reviewId,
    }));
}

export async function suggestionTurnRunning(store: Db, itemId: string): Promise<number | null> {
  return await store.run((q) =>
    runningJobIdSteps(q, JOB_KIND.resume, suggestionTurnJobKey(itemId)),
  );
}

function* restartComingSteps(q: Q, itemId: string) {
  return (
    (yield* latestItemJobIdSteps(q, itemId, [JOB_KIND.start, JOB_KIND.resume], ["pending"])) !==
      null ||
    (yield* pendingPullCommentsSteps(q, itemId)).length > 0 ||
    (yield* pendingChangeRequestsSteps(q, itemId)).length > 0 ||
    (yield* pendingPullCiFailuresSteps(q, itemId)).length > 0 ||
    (yield* pendingLinearCommentsSteps(q, itemId)).length > 0
  );
}

export type SuggestionTurn = "started" | "skipped" | "none";

export async function startSuggestionTurn(
  store: Db,
  input: { itemId: string; head: string; suggestions: number; now: number },
): Promise<SuggestionTurn> {
  let armed = false;
  const turn = await store.transaction(function* (q): Steps<SuggestionTurn> {
    const item = yield* getWorkItemSteps(q, input.itemId);
    if (!item || item.state !== "merge_queue" || item.cancelRequested) return "none";
    if (input.suggestions === 0 || (yield* getSuggestionTurnSteps(q, item.id)) !== null)
      return "none";
    if (yield* restartComingSteps(q, item.id)) {
      yield* recordSuggestionTurnSteps(q, {
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
      yield* recordSuggestionTurnSteps(q, {
        itemId: item.id,
        outcome: "skipped",
        reason: `${Math.max(0, Math.floor(remaining / 60_000))} minutes of the awake budget remain, under 45; the next turn carries the suggestions.`,
        head: input.head,
        recordedAt: input.now,
      });
      return "skipped";
    }
    const job = yield* restartSteps(q, item, {
      reason: "review",
      body: SUGGESTION_TURN_HANDOFF,
      jobKey: suggestionTurnJobKey(item.id),
      now: input.now,
    });
    if (job === null) return "none";
    armed = job.armed;
    yield* recordSuggestionTurnSteps(q, {
      itemId: item.id,
      outcome: "started",
      reason: null,
      head: input.head,
      recordedAt: input.now,
    });
    return "started";
  });
  if (armed) emitJobReady(store);
  return turn;
}
