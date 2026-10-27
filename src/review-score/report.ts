import { existsSync, readFileSync } from "node:fs";
import type { NotEscapeReason, ReviewEscapeRecord, ReviewEscapeTrigger } from "../db";

/** The escaped bugs found by pairing a merged pull request with a later fix, one JSON object a line. */
export const REVIEW_ESCAPES_FILE = "evals/review-escapes.jsonl";

const TRIGGERS: readonly ReviewEscapeTrigger[] = ["ci", "review", "comment"];
const TRIGGER_LABEL: Record<ReviewEscapeTrigger, string> = {
  ci: "CI failed",
  review: "Changes requested",
  comment: "PR comment",
};
const REASON_LABEL: Record<NotEscapeReason, string> = {
  flake: "also fails on main",
  tests_docs_format: "tests, docs or formatting only",
  no_change: "no change",
  unreviewed: "outside the reviewed files",
};

export type TriggerCount = {
  trigger: ReviewEscapeTrigger;
  escapes: number;
  notEscapes: Partial<Record<NotEscapeReason, number>>;
  /** Candidates whose fix Closeout has not accepted yet. */
  open: number;
};

export type ReviewScore = {
  /** Escapes after merge from {@link REVIEW_ESCAPES_FILE}; null when the file is missing. */
  afterMerge: number | null;
  /** Candidates found on the pull request after Closeout accepted its head, per trigger. */
  afterPullRequest: TriggerCount[];
};

/** The escape lines of the evals file, or null when there is no file. */
export function readReviewEscapesFile(path: string): Record<string, unknown>[] | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      try {
        const value: unknown = JSON.parse(line);
        return typeof value === "object" && value !== null && !Array.isArray(value)
          ? [value as Record<string, unknown>]
          : [];
      } catch {
        return [];
      }
    });
}

export function scoreReview(
  candidates: readonly ReviewEscapeRecord[],
  afterMerge: readonly unknown[] | null,
): ReviewScore {
  return {
    afterMerge: afterMerge === null ? null : afterMerge.length,
    afterPullRequest: TRIGGERS.map((trigger) => {
      const count: TriggerCount = { trigger, escapes: 0, notEscapes: {}, open: 0 };
      for (const candidate of candidates) {
        if (candidate.trigger !== trigger) continue;
        if (candidate.escape === null) count.open++;
        else if (candidate.escape) count.escapes++;
        else {
          const reason = candidate.notEscapeReason ?? "no_change";
          count.notEscapes[reason] = (count.notEscapes[reason] ?? 0) + 1;
        }
      }
      return count;
    }),
  };
}

/** The score report as plain text. */
export function formatReviewScore(score: ReviewScore): string {
  const total = score.afterPullRequest.reduce((sum, count) => sum + count.escapes, 0);
  const lines = [
    "Independent review escapes",
    "",
    score.afterMerge === null
      ? `Escaped after merge: no ${REVIEW_ESCAPES_FILE}`
      : `Escaped after merge: ${score.afterMerge}`,
    `Found after the PR: ${total}`,
  ];
  for (const count of score.afterPullRequest) {
    const not = Object.entries(count.notEscapes)
      .map(([reason, n]) => `${n} ${REASON_LABEL[reason as NotEscapeReason]}`)
      .join(", ");
    const extra = [not ? `not escapes: ${not}` : "", count.open ? `${count.open} open` : ""]
      .filter((part) => part !== "")
      .join("; ");
    lines.push(`  ${TRIGGER_LABEL[count.trigger]}: ${count.escapes}${extra ? ` (${extra})` : ""}`);
  }
  return lines.join("\n");
}
