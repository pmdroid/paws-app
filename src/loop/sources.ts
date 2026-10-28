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

type BranchItem = Pick<
  WorkItemRecord,
  "id" | "taskKey" | "linearIssueId" | "linearIdentifier" | "continuesBranch"
>;

/** An item that continues an earlier one pushes to that item's branch, so its pull request stays. */
export function taskBranchKey(item: BranchItem): string {
  const continued = item.continuesBranch?.startsWith("paws/")
    ? item.continuesBranch.slice("paws/".length)
    : null;
  return continued || itemPathId(item).toLowerCase();
}

/** Where a new worktree starts: the tip of the continued branch, else main. */
export function worktreeStartRef(item: BranchItem): string | undefined {
  return item.continuesBranch ? `origin/${worktreeBranch(item)}` : undefined;
}

export function worktreeBranch(item: BranchItem): string {
  return `paws/${taskBranchKey(item)}`;
}
