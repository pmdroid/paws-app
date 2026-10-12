import type { WorkItemRecord } from "../db";

/**
 * Directory and branch key for one work item.
 * GitHub ids use the same `gh-<owner>-<repo>-<n>` key the pull request push uses.
 * Linear identifiers are already a single path segment.
 */
export function itemPathId(item: {
  id?: string;
  taskKey?: string | null;
  linearIssueId: string;
  linearIdentifier: string;
}): string {
  const name = item.linearIdentifier;
  return item.id && item.taskKey && !item.taskKey.startsWith("initial:")
    ? `${name.slice(0, 54)}-${item.id}`
    : name;
}

export function worktreeBranch(
  item: Pick<WorkItemRecord, "id" | "taskKey" | "linearIssueId" | "linearIdentifier">,
): string {
  return `paws/${itemPathId(item).toLowerCase()}`;
}
