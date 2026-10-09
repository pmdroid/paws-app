const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9._-]{0,80}$/;

/** Branch pushed for one issue: `paws/<issue>`. */
export function branchForIssue(issue: string): string {
  if (!ISSUE_KEY.test(issue)) throw new Error(`invalid issue key: ${issue}`);
  return `paws/${issue}`;
}

/** Linear closes the issue when the PR body contains this line. */
export function fixesLine(issue: string): string {
  if (!ISSUE_KEY.test(issue)) throw new Error(`invalid issue key: ${issue}`);
  return `Fixes ${issue}`;
}

export function pullRequestBody(issue: string, evidence: string): string {
  const body = evidence.trim();
  return body === "" ? `${fixesLine(issue)}\n` : `${fixesLine(issue)}\n\n${body}\n`;
}

export function githubHttpsUrl(owner: string, repo: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) {
    throw new Error("owner and repo must be url-safe names");
  }
  return `https://github.com/${owner}/${repo}.git`;
}
