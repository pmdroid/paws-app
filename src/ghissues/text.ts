import type { GitHubRepoRef } from "./types";

/** Tracker issue id. Stored in the existing `linear_issue_id` column. */
export function githubIssueKey(owner: string, repo: string, number: number): string {
  return `github:${owner}/${repo}#${number}`;
}

/** Human identifier. Stored in the existing `linear_identifier` column. */
export function githubIdentifier(repo: string, number: number): string {
  return `${repo}#${number}`;
}

export function repoSlug(repo: GitHubRepoRef): string {
  return `${repo.owner}/${repo.repo}`;
}

export function parseGitHubIssueKey(
  key: string,
): { owner: string; repo: string; number: number } | null {
  const match = /^github:([^/]+)\/([^#]+)#(\d+)$/.exec(key);
  const owner = match?.[1];
  const repo = match?.[2];
  const number = match?.[3];
  if (owner === undefined || repo === undefined || number === undefined) return null;
  return { owner, repo, number: Number(number) };
}

/**
 * Plain-text mention. `(^|\s)@paws\b` with the configured mention, so
 * `@pawsome` does not match.
 */
export function mentionsPaws(text: string, mention: string): boolean {
  if (mention.length === 0) return false;
  const escaped = mention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)${escaped}\\b`).test(text);
}

export function hasTriggerLabel(labels: readonly string[], triggerLabel: string): boolean {
  const want = triggerLabel.toLowerCase();
  return labels.some((label) => label.toLowerCase() === want);
}

/** A comment line that stops the run. Trusted authors only; enforced by the poller. */
export function isPawsStop(body: string): boolean {
  return body.split(/\r?\n/).some((line) => /^\/paws\s+stop\b/i.test(line.trim()));
}

export type TaskRef = {
  owner: string;
  repo: string;
  number: number;
};

/**
 * Unchecked task-list rows in body order.
 * `- [ ] #123` is the parent repo. `- [ ] owner/repo#123` is explicit.
 * Checked rows are skipped.
 */
export function parseTaskList(body: string | null, parent: GitHubRepoRef): TaskRef[] {
  if (body === null || body.length === 0) return [];
  const pattern = /^[ \t]*- \[([ xX])\][ \t]+(?:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+))?#(\d+)\b/gm;
  const found: TaskRef[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(pattern)) {
    const mark = match[1];
    const numberText = match[4];
    if (mark === undefined || numberText === undefined) continue;
    if (mark.toLowerCase() === "x") continue;
    const owner = match[2] ?? parent.owner;
    const repo = match[3] ?? parent.repo;
    const number = Number(numberText);
    if (!Number.isInteger(number) || number < 1) continue;
    const key = githubIssueKey(owner, repo, number);
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ owner, repo, number });
  }
  return found;
}
