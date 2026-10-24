/** One linked Linear issue in a parent summary. */
export type SummaryIssue = { identifier: string; url?: string | null };

export type SummarySubIssue = SummaryIssue & {
  title: string;
  /** Unfinished issues this sub-issue waits for. Empty when it started. */
  blockers: readonly SummaryIssue[];
};

/**
 * The single response that ends a delegated parent's Linear session. It names each
 * sub-issue, says whether it started or what it waits for, and where to steer it.
 */
export function parentSummaryMessage(subIssues: readonly SummarySubIssue[]): string {
  const count = subIssues.length;
  const head =
    count === 1
      ? "Started the work in 1 sub-issue. It runs in its own session, so reply there to steer it."
      : `Started the work in ${count} sub-issues. Each runs in its own session, so reply there to steer it.`;
  const lines = subIssues.map(
    (issue) =>
      `* ${link(issue)} ${oneLine(issue.title)}: ${
        issue.blockers.length ? `waits for ${joinAnd(issue.blockers.map(link))}` : "started"
      }`,
  );
  const stop =
    count === 1 ? "Stop this session to stop it." : "Stop this session to stop them all.";
  return [head, ...lines, "", stop].join("\n");
}

function link(issue: SummaryIssue): string {
  return issue.url ? `[${issue.identifier}](${issue.url})` : issue.identifier;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function joinAnd(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}
