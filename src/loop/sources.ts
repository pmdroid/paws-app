import type { WorkItemRecord } from "../db";
import { branchForIssue } from "../github";

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

type BranchItem = Pick<WorkItemRecord, "id" | "taskKey" | "linearIssueId" | "linearIdentifier">;

/**
 * The one remote branch of a task. The runner pushes the agent's work here, the
 * pull request uses it as its head, the rebase before a merge pushes to it and
 * the candidate fetch reads it.
 */
export function taskBranch(item: BranchItem): string {
  return branchForIssue(itemPathId(item));
}

/**
 * Lowercased agent branch older tasks pushed to before they shared the pull
 * request branch. Null when it is the same name as {@link taskBranch}.
 */
export function legacyTaskBranch(item: BranchItem): string | null {
  const branch = taskBranch(item);
  const legacy = branch.toLowerCase();
  return legacy === branch ? null : legacy;
}
