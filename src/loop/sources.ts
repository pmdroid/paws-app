import type { WorkItemRecord } from "../db";
import type { TrackerAdapter } from "../linear";

const GITHUB_ISSUE = /^github:([^/\s#]+)\/([^/\s#]+)#([1-9]\d*)$/;

/** True when the stored issue id came from the GitHub tracker. */
export function isGitHubIssue(id: string): boolean {
  return GITHUB_ISSUE.test(id);
}

/**
 * Directory and branch key for one work item.
 * GitHub ids use the same `gh-<owner>-<repo>-<n>` key the pull request push uses.
 * Linear identifiers are already a single path segment.
 */
export function itemPathId(item: { linearIssueId: string; linearIdentifier: string }): string {
  return githubBranchKey(item.linearIssueId) ?? item.linearIdentifier;
}

/** Issue argument for `publishAccepted`. GitHub keeps the `github:` id so the body is `Closes #n`. */
export function publishIssueKey(item: { linearIssueId: string; linearIdentifier: string }): string {
  return isGitHubIssue(item.linearIssueId) ? item.linearIssueId : item.linearIdentifier;
}

/**
 * One tracker port. `github:` keys go to the GitHub tracker. Every other key stays on Linear.
 * Progress, questions, and status use the same rule as epic reads.
 */
export function routeBySource(input: {
  linear: TrackerAdapter | null;
  github: TrackerAdapter | null;
}): TrackerAdapter {
  function pick(id: string): TrackerAdapter {
    const githubItem = isGitHubIssue(id);
    const chosen = githubItem ? input.github : input.linear;
    if (chosen === null) {
      throw new Error(githubItem ? "GitHub is not connected" : "Linear is not connected");
    }
    return chosen;
  }
  const linear = input.linear;
  return {
    ...(linear?.getSession ? { getSession: linear.getSession.bind(linear) } : {}),
    ...(linear?.listSessionActivities
      ? { listSessionActivities: linear.listSessionActivities.bind(linear) }
      : {}),
    loadEpic: (id) => pick(id).loadEpic(id),
    listDeps: (id) => pick(id).listDeps(id),
    postProgress: (update, options) => pick(update.sessionId).postProgress(update, options),
    askQuestion: (question, options) => pick(question.sessionId).askQuestion(question, options),
    setStatus: (update, options) => pick(update.linearIssueId).setStatus(update, options),
  };
}

export function worktreeBranch(
  item: Pick<WorkItemRecord, "linearIssueId" | "linearIdentifier">,
): string {
  return `paws/${itemPathId(item).toLowerCase()}`;
}

/**
 * Same shape as the private branch key in the GitHub pull-request publisher.
 * `serialMerge` names the branch from this string, and the publisher names it from the `github:` id.
 */
function githubBranchKey(issue: string): string | null {
  const match = GITHUB_ISSUE.exec(issue);
  if (match === null) return null;
  const owner = match[1];
  const repo = match[2];
  const raw = match[3];
  if (owner === undefined || repo === undefined || raw === undefined) return null;
  const suffix = `-${raw}`;
  const prefix = "gh-";
  const budget = 81 - prefix.length - suffix.length;
  let slug = `${owner}-${repo}`;
  if (slug.length > budget) slug = slug.slice(0, budget).replace(/[._-]+$/g, "");
  if (slug.length === 0) slug = "issue";
  const key = `${prefix}${slug}${suffix}`;
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,80}$/.test(key)) {
    throw new Error(`invalid issue key: ${issue}`);
  }
  return key;
}
