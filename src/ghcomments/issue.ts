const NAME = /^[A-Za-z0-9._-]+$/;
const TRACKER_ID = /^github:([^/\s#]+)\/([^/\s#]+)#([1-9]\d*)$/;
const SHORT_ID = /^([^/\s#]+)\/([^/\s#]+)#([1-9]\d*)$/;
const NUMBER_ID = /^[1-9]\d*$/;

export type GitHubIssueRef = {
  owner: string;
  repo: string;
  number: number;
};

export function repoPath(owner: string, repo: string, suffix: string): string {
  assertName(owner);
  assertName(repo);
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${suffix}`;
}

/** `github:owner/repo#n`, `owner/repo#n`, or a bare issue number with `fallback`. */
export function resolveGitHubIssue(
  issueId: string,
  fallback: { owner: string; repo: string },
): GitHubIssueRef {
  const parsed = TRACKER_ID.exec(issueId) ?? SHORT_ID.exec(issueId);
  if (parsed !== null) {
    const owner = parsed[1];
    const repo = parsed[2];
    const raw = parsed[3];
    if (owner === undefined || repo === undefined || raw === undefined) {
      throw new Error(`invalid GitHub issue id: ${issueId}`);
    }
    assertName(owner);
    assertName(repo);
    return { owner, repo, number: Number(raw) };
  }
  if (NUMBER_ID.test(issueId)) {
    assertName(fallback.owner);
    assertName(fallback.repo);
    return { owner: fallback.owner, repo: fallback.repo, number: Number(issueId) };
  }
  throw new Error(`invalid GitHub issue id: ${issueId}`);
}

export function canonicalIssueId(
  issueId: string,
  fallback: { owner: string; repo: string },
): string {
  const issue = resolveGitHubIssue(issueId, fallback);
  return `github:${issue.owner}/${issue.repo}#${issue.number}`;
}

function assertName(name: string): void {
  if (!NAME.test(name)) throw new Error(`invalid GitHub owner or repo: ${name}`);
}
