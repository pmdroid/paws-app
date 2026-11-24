import type { Db } from "../db";
import { branchHasMergeQueue, type SerialMergeResult } from "../github";
import type { MergePull } from "./orders";

const BASE_QUEUE_TTL_MS = 10 * 60_000;

const BASE_BRANCH = "main";

type Answer = { found: boolean; at: number };

const answers = new WeakMap<Db, Map<string, Answer>>();

function cacheFor(store: Db): Map<string, Answer> {
  let cache = answers.get(store);
  if (!cache) {
    cache = new Map();
    answers.set(store, cache);
  }
  return cache;
}

function key(published: Pick<MergePull, "repository">): string {
  return `${published.repository.owner}/${published.repository.repo}:${BASE_BRANCH}`;
}

export async function baseHasMergeQueue(
  store: Db,
  published: Pick<MergePull, "github" | "repository" | "signal">,
  now: number,
): Promise<boolean> {
  const { github, repository } = published;
  const cache = cacheFor(store);
  const cached = cache.get(key(published));
  if (cached && now - cached.at < BASE_QUEUE_TTL_MS) return cached.found;
  const found = await branchHasMergeQueue({
    owner: repository.owner,
    repo: repository.repo,
    branch: BASE_BRANCH,
    client: github.client,
    appId: github.appId,
    installationId: github.installationId,
    privateKeyPem: github.privateKeyPem,
    ...(github.tokenProvider ? { tokenProvider: github.tokenProvider } : {}),
    signal: published.signal,
  });
  if (found === null) {
    cache.delete(key(published));
    return false;
  }
  cache.set(key(published), { found, at: now });
  return found;
}

export function forgetBaseQueue(
  store: Db,
  published: Pick<MergePull, "github" | "repository">,
): void {
  cacheFor(store).delete(key(published));
}

export function refusedForMergeQueue(result: SerialMergeResult | null): boolean {
  return (
    result?.outcome === "merge_denied" &&
    /must be made through (?:a|the) merge queue/i.test(
      `${result.reason ?? ""} ${result.message ?? ""}`,
    )
  );
}
