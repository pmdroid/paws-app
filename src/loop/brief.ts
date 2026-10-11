import type { IssueBrief, WorkBrief } from "../core";

export function renderWorkBrief(brief: WorkBrief | null): string {
  if (brief === null) return "";
  return [
    "Task brief",
    "Use the issue description and acceptance criteria as the task requirements. The epic provides context for this child, not additional work items.",
    renderIssue("Issue", brief.issue),
    ...(brief.epic === null ? [] : [renderIssue("Epic context", brief.epic)]),
  ].join("\n\n");
}

function renderIssue(label: string, issue: IssueBrief): string {
  return [
    `${label}: ${issue.identifier}: ${issue.title}`,
    `Source: ${issue.source}; issue ID: ${issue.issueId}`,
    `Description (including acceptance criteria in the source body):\n${issue.description ?? ""}`,
    ...(issue.acceptanceCriteria === null
      ? []
      : [`Acceptance criteria:\n${issue.acceptanceCriteria}`]),
  ].join("\n\n");
}
