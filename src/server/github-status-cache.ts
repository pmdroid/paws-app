export type GitHubStatus = { status: string; installationUrl: string; repositoryCount: number };

export type GitHubStatusCache = ReturnType<typeof createGitHubStatusCache>;

export function createGitHubStatusCache(ttl = 60000) {
  const entries = new Map<string, { key: string; at: number; value: GitHubStatus }>();
  return {
    get(workspaceId: string, key: string, now: number) {
      const entry = entries.get(workspaceId);
      return entry && entry.key === key && now - entry.at < ttl ? entry.value : null;
    },
    set(workspaceId: string, key: string, now: number, value: GitHubStatus) {
      entries.set(workspaceId, { key, at: now, value });
    },
    clear(workspaceId: string) {
      entries.delete(workspaceId);
    },
  };
}

export async function everyLimited<T>(
  items: readonly T[],
  limit: number,
  test: (item: T) => Promise<boolean>,
) {
  let passed = true;
  await mapLimited(items, limit, async (item) => {
    if (passed && !(await test(item))) passed = false;
  });
  return passed;
}

export async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  map: (item: T) => Promise<R>,
) {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await map(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
