import { admittedRunnerVersionsSteps, liveInstancesSteps, type Db } from "../db";
import type { Alert } from "./alerts";

const HOUR_MS = 60 * 60_000;
export const DEPLOY_LAG_GRACE_MS = 4 * HOUR_MS;
export const DEPLOY_LAG_CRITICAL_MS = 24 * HOUR_MS;
export const DEPLOY_LAG_CACHE_MS = 15 * 60_000;
const SOURCE_TIMEOUT_MS = 10_000;

export type SourceRepository = {
  name: string;
  defaultBranch(signal: AbortSignal): Promise<string>;
  missing(
    base: string,
    branch: string,
    signal: AbortSignal,
  ): Promise<{ count: number; committedAt: number[] } | null>;
  contains(base: string, sha: string, signal: AbortSignal): Promise<boolean>;
  latestRelease(signal: AbortSignal): Promise<{ version: string; publishedAt: number } | null>;
};

export type DeployLagCheck = {
  store: Db;
  source: SourceRepository | null;
  clock: () => number;
  read<T>(
    key: string,
    fetch: (source: SourceRepository, signal: AbortSignal) => Promise<T>,
  ): Promise<T>;
};

export function createDeployLagCheck(
  store: Db,
  source: SourceRepository | null,
  clock: () => number = Date.now,
): DeployLagCheck {
  const cache = new Map<string, { at: number; value: Promise<unknown> }>();
  return {
    store,
    source,
    clock,
    read<T>(key: string, fetch: (source: SourceRepository, signal: AbortSignal) => Promise<T>) {
      if (source === null) return Promise.reject(new Error("The source repository is unknown."));
      const now = clock();
      const hit = cache.get(key);
      if (hit && now - hit.at < DEPLOY_LAG_CACHE_MS) return hit.value as Promise<T>;
      const value = fetch(source, AbortSignal.timeout(SOURCE_TIMEOUT_MS));
      cache.set(key, { at: now, value });
      return value;
    },
  };
}

function revisionRef(version: string | null): string | null {
  if (version?.startsWith("git:")) return version.slice(4) || null;
  return version !== null && /^\d+\.\d+\.\d+$/.test(version) ? `v${version}` : null;
}

async function runningRefs(check: DeployLagCheck, now: number): Promise<string[]> {
  const instances = await check.store.run((q) => liveInstancesSteps(q, now));
  return [...new Set(instances.map((instance) => revisionRef(instance.version)))].filter(
    (ref): ref is string => ref !== null,
  );
}

const defaultBranch = (check: DeployLagCheck) =>
  check.read("branch", (source, signal) => source.defaultBranch(signal));

export async function deployLagUnavailable(
  check: DeployLagCheck,
  now = check.clock(),
): Promise<string | null> {
  if (check.source === null) return "the running checkout has no GitHub origin remote";
  if ((await runningRefs(check, now)).length === 0)
    return "the running Paws has no git revision or release version";
  return defaultBranch(check).then(
    () => null,
    (error: unknown) =>
      `the GitHub App can't read ${check.source?.name}: ${error instanceof Error ? error.message : String(error)}`,
  );
}

export async function runningRevisionContains(
  check: DeployLagCheck,
  commitSha: string,
  now = check.clock(),
): Promise<boolean | null> {
  if ((await deployLagUnavailable(check, now)) !== null) return null;
  const refs = await runningRefs(check, now);
  const found = await Promise.all(
    refs.map((ref) =>
      check.read(`contains:${ref}:${commitSha}`, (source, signal) =>
        source.contains(ref, commitSha, signal),
      ),
    ),
  );
  return found.every(Boolean);
}

export async function runningDeployIncludes(
  check: DeployLagCheck,
  commitSha: string,
): Promise<boolean | string> {
  const unavailable = await deployLagUnavailable(check);
  if (unavailable !== null) return unavailable;
  return runningRevisionContains(check, commitSha).then(
    (found) => found ?? "the running revision can't be read",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
}

const hours = (ms: number) => `${Math.floor(ms / HOUR_MS)} h`;

async function deployLag(check: DeployLagCheck, now: number): Promise<Alert[]> {
  if ((await deployLagUnavailable(check, now)) !== null) return [];
  const branch = await defaultBranch(check);
  const alerts: Alert[] = [];
  for (const ref of await runningRefs(check, now)) {
    const missing = await check
      .read(`missing:${ref}`, (source, signal) => source.missing(ref, branch, signal))
      .catch(() => null);
    if (!missing || missing.count === 0 || missing.committedAt.length === 0) continue;
    const oldest = Math.min(...missing.committedAt);
    if (now - oldest <= DEPLOY_LAG_GRACE_MS) continue;
    alerts.push({
      id: `deploy_lag:${ref}`,
      severity: now - oldest > DEPLOY_LAG_CRITICAL_MS ? "critical" : "warning",
      title: `The running Paws lacks ${missing.count} commits from ${branch}`,
      detail: `${ref} lacks ${missing.count} commits on ${check.source?.name} ${branch}; the oldest was committed ${hours(now - oldest)} ago.`,
      since: oldest,
      count: missing.count,
    });
  }
  return alerts;
}

async function runnersBehind(check: DeployLagCheck, now: number): Promise<Alert[]> {
  const release = await check
    .read("release", (source, signal) => source.latestRelease(signal))
    .catch(() => null);
  if (release === null || now - release.publishedAt <= DEPLOY_LAG_GRACE_MS) return [];
  const runners = await check.store.run((q) => admittedRunnerVersionsSteps(q));
  return runners
    .filter(
      (runner) =>
        runner.version !== null &&
        Bun.semver.order(runner.version.replace(/^v/, ""), release.version) < 0,
    )
    .map((runner) => ({
      id: `runner_behind:${runner.id}`,
      severity: "warning",
      title: `Runner ${runner.name} runs ${runner.version}, below release ${release.version}`,
      detail: `${release.version} was published ${hours(now - release.publishedAt)} ago.`,
      since: release.publishedAt,
      count: 1,
    }));
}

export async function deployLagAlerts(check: DeployLagCheck, now = Date.now()): Promise<Alert[]> {
  if (check.source === null) return [];
  return [...(await deployLag(check, now)), ...(await runnersBehind(check, now))];
}
