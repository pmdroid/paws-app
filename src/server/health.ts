import { statfsSync } from "node:fs";
import {
  actionableDueSteps,
  databaseProbeSteps,
  deadJobCountSteps,
  deadOutboxCountSteps,
  expiredJobLeaseCountSteps,
  JOB_PROGRESS_STALE_MS,
  journal,
  latestGithubDeliverySteps,
  LINEAR_WEBHOOK_SILENCE_MS,
  liveInstancesSteps,
  runnerHeartbeatsSteps,
  syncCursorSteps,
  type Db,
  type JobLoopLiveness,
  type Q,
  type Steps,
} from "../db";
import { RUNNER_ONLINE_MS } from "../runner-placement";
import { RUNNER_LEASE_GRACE_MS } from "../runner-protocol";

type Check = {
  status: "ok" | "failed" | "skipped";
  reason?: string;
  count?: number;
  ageMs?: number | null;
  maxAgeMs?: number;
  paths?: Record<string, { freeBytes: number; minFreeBytes: number }>;
};

export type HealthOptions = {
  store?: Db;
  linearWebhook: boolean;
  githubWebhook: boolean;
  now?: () => number;
  /**
   * Live job loop. Omitted when this process has no loop (onboarding). A null
   * or not-yet-polling result means startup, not a stall.
   */
  jobLoop?: () => JobLoopLiveness | null;
  disk?: { paths: Readonly<Record<string, string>>; statfs?: StatFs };
  instanceId?: string;
};

type LiveInstance = { id: string; role: string; version: string | null; heartbeatAt: number };

type StatFs = (path: string) => { bavail: number; blocks: number; bsize: number };

function diskSpace(path: string, statfs: StatFs = statfsSync) {
  const stats = statfs(path);
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  const minFreeBytes = Math.max(
    1024 ** 3,
    Math.ceil(Number(stats.blocks) * Number(stats.bsize) * 0.05),
  );
  return { freeBytes, minFreeBytes, low: freeBytes < minFreeBytes };
}

/** Local reads only. Log changes so a failed probe and recovery appear in the journal. */
export function createHealthReport(options: HealthOptions) {
  let previous: string | undefined;
  return async () => {
    const store = options.store;
    const now = options.now?.() ?? Date.now();
    const checks: Record<string, Check> = {};
    try {
      if (!store) throw new Error("database unavailable");
      await store.run(databaseProbeSteps);
      checks.database = { status: "ok" };
    } catch {
      checks.database = { status: "failed", reason: "unavailable" };
    }
    const read = async (name: string, query: () => Check | Promise<Check>) => {
      if (checks.database!.status !== "ok") {
        checks[name] = { status: "skipped", reason: "database_unavailable" };
        return;
      }
      try {
        checks[name] = await query();
      } catch {
        // Do not expose SQL errors, file paths, or delivery contents on this public route.
        checks[name] = { status: "failed", reason: "read_failed" };
      }
    };
    const count = (name: string, steps: (q: Q) => Steps<number>) =>
      read(name, async () => {
        const value = await store!.run(steps);
        return { status: value === 0 ? "ok" : "failed", count: value };
      });
    await count("jobLeases", (q) => expiredJobLeaseCountSteps(q, now));
    if (options.jobLoop === undefined) {
      checks.jobProgress = { status: "skipped", reason: "not_observed" };
    } else {
      await read("jobProgress", async () => {
        const live = options.jobLoop?.() ?? null;
        if (live === null || !live.polling) return { status: "skipped", reason: "starting" };
        const due = await store!.run((q) => actionableDueSteps(q, now));
        if (due.count === 0 || due.oldestRunAt === null) return { status: "ok", count: 0 };
        const ageMs = Math.max(0, now - due.oldestRunAt);
        const tickAge = live.lastTickAt === null ? null : Math.max(0, now - live.lastTickAt);
        const claimAge = live.lastClaimAt === null ? null : Math.max(0, now - live.lastClaimAt);
        const tickStale = tickAge === null || tickAge >= JOB_PROGRESS_STALE_MS;
        const claimStale = claimAge === null || claimAge >= JOB_PROGRESS_STALE_MS;
        // Full general capacity is progress, even when a handler outlives the minute.
        const saturated = live.inFlight >= live.workerCount;
        const detail = { count: due.count, ageMs, maxAgeMs: JOB_PROGRESS_STALE_MS };
        if (ageMs < JOB_PROGRESS_STALE_MS || saturated || (!tickStale && !claimStale))
          return { status: "ok", ...detail };
        return {
          status: "failed",
          reason: tickStale ? "loop_idle" : "due_unclaimed",
          ...detail,
        };
      });
    }
    await count("deadJobs", deadJobCountSteps);
    await count("deadOutbox", deadOutboxCountSteps);
    await read("runnerHeartbeats", async () => {
      const maxAgeMs = RUNNER_ONLINE_MS + RUNNER_LEASE_GRACE_MS;
      const row = await store!.run((q) => runnerHeartbeatsSteps(q, now - maxAgeMs));
      if (row.total === 0) return { status: "skipped", reason: "no_active_runners" };
      return {
        status: row.stale === 0 ? "ok" : "failed",
        count: row.stale,
        ageMs: row.oldest === null ? null : Math.max(0, now - row.oldest),
        maxAgeMs,
      };
    });
    const webhook = async (
      name: string,
      configured: boolean,
      steps: (q: Q) => Steps<number | null>,
    ) => {
      if (!configured) {
        checks[name] = { status: "skipped", reason: "not_configured" };
        return;
      }
      await read(name, async () => {
        const at = await store!.run(steps);
        const ageMs = at === null ? null : Math.max(0, now - at);
        const maxAgeMs = LINEAR_WEBHOOK_SILENCE_MS;
        return {
          status: ageMs !== null && ageMs <= maxAgeMs ? "ok" : "failed",
          ...(at === null ? { reason: "never_received" } : {}),
          ageMs,
          maxAgeMs,
        };
      });
    };
    await webhook("linearWebhook", options.linearWebhook, (q) =>
      syncCursorSteps(q, "linear:webhook"),
    );
    await webhook("githubWebhook", options.githubWebhook, latestGithubDeliverySteps);
    if (options.disk === undefined) {
      checks.diskSpace = { status: "skipped", reason: "not_configured" };
    } else {
      try {
        const spaces = Object.entries(options.disk.paths).map(
          ([label, path]) => [label, diskSpace(path, options.disk!.statfs)] as const,
        );
        checks.diskSpace = {
          status: spaces.some(([, space]) => space.low) ? "failed" : "ok",
          paths: Object.fromEntries(
            spaces.map(([label, { freeBytes, minFreeBytes }]) => [
              label,
              { freeBytes, minFreeBytes },
            ]),
          ),
        };
      } catch {
        checks.diskSpace = { status: "failed", reason: "read_failed" };
      }
    }
    let instances: LiveInstance[] = [];
    if (checks.database!.status === "ok") {
      try {
        instances = (await store!.run((q) => liveInstancesSteps(q, now))).map(
          ({ id, role, version, heartbeatAt }) => ({
            id,
            role,
            version,
            heartbeatAt,
          }),
        );
      } catch {
        instances = [];
      }
    }
    const failedChecks = Object.keys(checks).filter((name) => checks[name]!.status === "failed");
    const state = failedChecks.join(",");
    if (state !== previous) {
      if (state || previous !== undefined)
        journal(state ? `health: failing checks: ${state}` : "health: healthy");
      previous = state;
    }
    return {
      ok: failedChecks.length === 0,
      service: "paws",
      instance: options.instanceId ?? null,
      instances,
      checks,
      failedChecks,
    };
  };
}

export type HealthReport = Awaited<ReturnType<ReturnType<typeof createHealthReport>>>;
