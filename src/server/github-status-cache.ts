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
      return value;
    },
    clear(workspaceId: string) {
      entries.delete(workspaceId);
    },
  };
}

export function everyLimited<T>(
  items: readonly T[],
  limit: number,
  test: (item: T) => Promise<boolean>,
) {
  let stopped = false;
  return new Promise<boolean>((resolve, reject) => {
    const stop = (settle: () => void) => {
      stopped = true;
      settle();
    };
    const check = async (item: T) => (await test(item)) || stop(() => resolve(false));
    mapLimited(items, limit, check, () => stopped).then(
      () => resolve(true),
      (caught: unknown) => stop(() => reject(caught)),
    );
  });
}

export async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  map: (item: T) => Promise<R>,
  stopped = () => false,
) {
  const results: R[] = [];
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < items.length && !stopped(); index = next++)
      results[index] = await map(items[index]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
