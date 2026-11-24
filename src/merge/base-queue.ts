import type { Db } from "../db";
import { branchHasMergeQueue, type GitHubQueueMergeInput, type SerialMergeResult } from "../github";
import type { MergePull } from "./orders";

const BASE_QUEUE_TTL_MS = 10 * 60_000;

const PAWS_BASE_BRANCH = "main";

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

type Target = Pick<MergePull, "repository" | "pull">;

function branchKey(published: Pick<MergePull, "repository">, branch: string): string {
  return `${published.repository.owner}/${published.repository.repo}:${branch}`;
}

function pullKey(published: Target): string {
  return `${published.repository.owner}/${published.repository.repo}#${published.pull.number}`;
}

function fresh(cache: Map<string, Answer>, key: string, now: number): boolean | undefined {
  const cached = cache.get(key);
  if (!cached) return undefined;
  if (now - cached.at < BASE_QUEUE_TTL_MS) return cached.found;
  cache.delete(key);
  return undefined;
}

export async function baseHasMergeQueue(
  store: Db,
  published: Pick<MergePull, "github" | "repository" | "pull" | "signal">,
  now: number,
): Promise<boolean> {
  const { github, repository } = published;
  const cache = cacheFor(store);
  if (fresh(cache, pullKey(published), now)) return true;
  const key = branchKey(published, PAWS_BASE_BRANCH);
  const cached = fresh(cache, key, now);
  if (cached !== undefined) return cached;
  const found = await branchHasMergeQueue({
    owner: repository.owner,
    repo: repository.repo,
    branch: PAWS_BASE_BRANCH,
    client: github.client,
    appId: github.appId,
    installationId: github.installationId,
    privateKeyPem: github.privateKeyPem,
    ...(github.tokenProvider ? { tokenProvider: github.tokenProvider } : {}),
    signal: published.signal,
  });
  if (found === null) return false;
  cache.set(key, { found, at: now });
  return found;
}

export function baseQueueCache(
  store: Db,
  published: Pick<MergePull, "repository">,
  now: () => number,
): NonNullable<GitHubQueueMergeInput["queueCache"]> {
  const cache = cacheFor(store);
  return {
    get: (branch) => fresh(cache, branchKey(published, branch), now()),
    set: (branch, found) => cache.set(branchKey(published, branch), { found, at: now() }),
  };
}

export function requireBaseQueue(store: Db, published: Target, now: number): void {
  const cache = cacheFor(store);
  cache.delete(branchKey(published, PAWS_BASE_BRANCH));
  cache.set(pullKey(published), { found: true, at: now });
}

export function forgetRequiredQueue(store: Db, published: Target): void {
  cacheFor(store).delete(pullKey(published));
}

export function refusedForMergeQueue(result: SerialMergeResult | null): boolean {
  return (
    result?.outcome === "merge_denied" &&
    /must be made through (?:a|the) merge queue/i.test(
      `${result.reason ?? ""} ${result.message ?? ""}`,
    )
  );
}
