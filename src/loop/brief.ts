import type { IssueBrief, WorkBrief } from "../core";

export function renderWorkBrief(brief: WorkBrief | null): string {
  if (brief === null) return "";
  return [
    "Task brief",
    "Use the issue description and acceptance criteria as the task requirements. The delegation provides context for this child, not additional work items.",
    renderIssue("Issue", brief.issue),
    ...(brief.epic === null ? [] : [renderIssue("Delegation context", brief.epic)]),
  ].join("\n\n");
}

/** The acceptance-criteria block, or nothing when the issue has none. */
export function acceptanceCriteriaSection(value: string | null): string {
  return value === null ? "" : `Acceptance criteria:\n${value}`;
}

/** The parent issue, rendered the way the brief has always shown it. Empty when there is none. */
export function renderParentBrief(epic: IssueBrief | null): string {
  return epic === null ? "" : renderIssue("Delegation context", epic);
}

function renderIssue(label: string, issue: IssueBrief): string {
  return [
    `${label}: ${issue.identifier}: ${issue.title}`,
    `Source: ${issue.source}; issue ID: ${issue.issueId}`,
    `Description (including acceptance criteria in the source body):\n${issue.description ?? ""}`,
    ...(issue.acceptanceCriteria === null
      ? []
      : [acceptanceCriteriaSection(issue.acceptanceCriteria)]),
  ].join("\n\n");
}
