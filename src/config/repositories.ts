export function parseRepositoryList(value: string): string[] {
  const repos = value
    .split(",")
    .map((repo) => repo.trim().toLowerCase())
    .filter((repo) => repo.length > 0);
  for (const repo of repos)
    if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repo))
      throw new Error(`${repo} is not an owner/repo name.`);
  return [...new Set(repos)];
}
