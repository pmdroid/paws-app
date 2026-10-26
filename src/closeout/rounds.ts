import type { Finding } from "./types";

/** One review round: the commit reviewed and how many findings the reviews reported there. */
export type ReviewRoundSummary = { head: string; findings: number };

/** A finding of the last round, with the class of bug its explanation starts with. */
export type OpenFinding = { severity: string; location: string; bugClass: string };

export type ReviewRounds = {
  rounds: ReviewRoundSummary[];
  open: OpenFinding[];
  /** The class reported most often across the rounds; the later one wins a tie. */
  bugClass: string | null;
};

/** The class a finding has when its explanation does not start with one. */
export const UNCLASSIFIED = "unclassified";

const CLASS_LIMIT = 60;

/**
 * The class of bug a finding's explanation starts with, as the review prompt
 * asks: "unchecked null: the handler reads …" is `unchecked null`.
 */
export function bugClass(explanation: string): string {
  const lead = /^\s*([^:.;\n—]+?)\s*(?::|—| - |\.|;|\n)/.exec(explanation)?.[1]?.trim() ?? "";
  if (lead === "" || lead.length > CLASS_LIMIT) return UNCLASSIFIED;
  return lead.toLowerCase();
}

/**
 * Groups review records into rounds, one per head in the order they were
 * written. A head reviewed more than once counts its latest attempt of each
 * review. The open findings are the last round's.
 */
export function summarizeReviewRounds(
  records: readonly {
    itemId: string;
    head: string;
    attempt: number;
    findings: readonly Finding[];
  }[],
): ReviewRounds {
  const heads: string[] = [];
  const latest = new Map<string, Map<string, { attempt: number; findings: readonly Finding[] }>>();
  for (const record of records) {
    if (!latest.has(record.head)) {
      heads.push(record.head);
      latest.set(record.head, new Map());
    }
    const byItem = latest.get(record.head)!;
    const prior = byItem.get(record.itemId);
    if (prior === undefined || prior.attempt <= record.attempt)
      byItem.set(record.itemId, { attempt: record.attempt, findings: record.findings });
  }
  const findingsAt = (head: string) =>
    [...latest.get(head)!.values()].flatMap((entry) => entry.findings);
  const counts = new Map<string, { count: number; last: number }>();
  heads.forEach((head, index) => {
    for (const finding of findingsAt(head)) {
      const name = bugClass(finding.explanation);
      if (name === UNCLASSIFIED) continue;
      counts.set(name, { count: (counts.get(name)?.count ?? 0) + 1, last: index });
    }
  });
  const top = [...counts.entries()].sort(
    ([, left], [, right]) => right.count - left.count || right.last - left.last,
  )[0];
  const last = heads.at(-1);
  return {
    rounds: heads.map((head) => ({ head, findings: findingsAt(head).length })),
    open:
      last === undefined
        ? []
        : findingsAt(last).map((finding) => ({
            severity: finding.severity,
            location: finding.location,
            bugClass: bugClass(finding.explanation),
          })),
    bugClass: top?.[0] ?? null,
  };
}
