import { cycleMessage, orderByBlocks, type OrderNode } from "../intake";
import type { DependencyEdge, EpicSnapshot } from "../linear";
import { GitHubRequestError, type GitHubIssuesClient } from "./client";
import { githubIdentifier, githubIssueKey, parseGitHubIssueKey, parseTaskList } from "./text";
import type { GitHubIssue, GitHubRepoRef } from "./types";

export class GitHubEpicCycleError extends Error {
  readonly identifiers: readonly string[];

  constructor(identifiers: readonly string[]) {
    super(cycleMessage(identifiers));
    this.name = "GitHubEpicCycleError";
    this.identifiers = identifiers;
  }
}

/**
 * Sub-issues in API order, otherwise unchecked task-list rows in body order,
 * otherwise the issue alone (`subIssues` empty). Blocked-by edges are ordered
 * with `orderByBlocks`. A cycle posts one comment and throws; nothing is queued.
 */
export async function loadGitHubEpic(
  client: GitHubIssuesClient,
  issue: GitHubRepoRef & { number: number },
): Promise<EpicSnapshot> {
  const parentRef: GitHubRepoRef = { owner: issue.owner, repo: issue.repo };
  const parent = await client.getIssue(parentRef, issue.number);
  const children = await loadChildren(client, parentRef, parent);
  const nodes = workNodes(parent, children);
  const edges = await loadEdges(client, nodes);
  const ordered = orderByBlocks(nodes, edges);
  if (!ordered.ok) {
    const identifiers = ordered.remaining.map((node) => node.identifier);
    await client.postComment(parentRef, parent.number, cycleMessage(identifiers));
    throw new GitHubEpicCycleError(identifiers);
  }
  return {
    linearIssueId: githubIssueKey(parent.owner, parent.repo, parent.number),
    identifier: githubIdentifier(parent.repo, parent.number),
    title: parent.title,
    description: parent.body,
    subIssues:
      children.length === 0
        ? []
        : ordered.ordered.map((node) => ({
            linearIssueId: node.linearIssueId,
            identifier: node.identifier,
            title: node.title,
          })),
  };
}

async function loadChildren(
  client: GitHubIssuesClient,
  parent: GitHubRepoRef,
  issue: GitHubIssue,
): Promise<GitHubIssue[]> {
  const subIssues = (await client.listSubIssues(parent, issue.number)).filter(
    (child) => !child.pullRequest && !sameIssue(child, issue),
  );
  if (subIssues.length > 0) return dedupeIssues(subIssues);
  const tasks = parseTaskList(issue.body, parent);
  if (tasks.length === 0) return [];
  const resolved: GitHubIssue[] = [];
  for (const task of tasks) {
    const loaded = await loadTask(client, task);
    if (loaded === null || loaded.pullRequest) continue;
    resolved.push(loaded);
  }
  return dedupeIssues(resolved);
}

async function loadTask(
  client: GitHubIssuesClient,
  task: GitHubRepoRef & { number: number },
): Promise<GitHubIssue | null> {
  try {
    return await client.getIssue({ owner: task.owner, repo: task.repo }, task.number);
  } catch (error) {
    if (error instanceof GitHubRequestError && error.status === 404) return null;
    throw error;
  }
}

function workNodes(parent: GitHubIssue, children: readonly GitHubIssue[]): OrderNode[] {
  const source = children.length === 0 ? [parent] : children;
  return source.map((issue) => ({
    linearIssueId: githubIssueKey(issue.owner, issue.repo, issue.number),
    identifier: githubIdentifier(issue.repo, issue.number),
    title: issue.title,
  }));
}

async function loadEdges(
  client: GitHubIssuesClient,
  nodes: readonly OrderNode[],
): Promise<DependencyEdge[]> {
  const edges: DependencyEdge[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    const ref = parseGitHubIssueKey(node.linearIssueId);
    if (ref === null) continue;
    const blockers = await client.listBlockedBy({ owner: ref.owner, repo: ref.repo }, ref.number);
    for (const blocker of blockers) {
      if (blocker.pullRequest) continue;
      const edge: DependencyEdge = {
        blockerLinearIssueId: githubIssueKey(blocker.owner, blocker.repo, blocker.number),
        blockedLinearIssueId: node.linearIssueId,
      };
      const key = `${edge.blockerLinearIssueId}|${edge.blockedLinearIssueId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push(edge);
    }
  }
  return edges;
}

function dedupeIssues(issues: readonly GitHubIssue[]): GitHubIssue[] {
  const seen = new Set<string>();
  const out: GitHubIssue[] = [];
  for (const issue of issues) {
    const key = githubIssueKey(issue.owner, issue.repo, issue.number);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out;
}

function sameIssue(left: GitHubIssue, right: GitHubIssue): boolean {
  return (
    left.number === right.number &&
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.repo.toLowerCase() === right.repo.toLowerCase()
  );
}
