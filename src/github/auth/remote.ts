const NAME = /^[A-Za-z0-9._-]+$/;

export function parseGitHubRemote(remoteUrl: string): { owner: string; repo: string } {
  const url = remoteUrl.trim();
  const path = githubPath(url);
  if (!path) {
    throw new Error(`remote is not a GitHub repository URL: ${redactRemote(url)}`);
  }
  const [owner, repo] = path;
  if (!owner || !repo || !NAME.test(owner) || !NAME.test(repo)) {
    throw new Error(`remote is not a GitHub repository URL: ${redactRemote(url)}`);
  }
  return { owner, repo };
}

function githubPath(url: string): [string, string] | null {
  const scp = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(url);
  if (scp?.[1] && scp[2]) return [scp[1], scp[2]];
  const web =
    /^(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(
      url,
    );
  if (web?.[1] && web[2]) return [web[1], web[2]];
  return null;
}

function redactRemote(url: string): string {
  return url.replace(/\/\/[^/\s@]+@/g, "//");
}
