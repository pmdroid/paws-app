import type { Database } from "bun:sqlite";
import { journal, LINEAR_WEBHOOK_SILENCE_MS } from "../db";
import { RUNNER_ONLINE_MS } from "../runner-placement";
import { RUNNER_LEASE_GRACE_MS } from "../runner-protocol";

type Check = {
  status: "ok" | "failed" | "skipped";
  reason?: string;
  count?: number;
  ageMs?: number | null;
  maxAgeMs?: number;
};

export type HealthOptions = {
  db?: Database;
  linearWebhook: boolean;
  githubWebhook: boolean;
  now?: () => number;
};

/** Local reads only. Log changes so a failed probe and recovery appear in the journal. */
export function createHealthReport(options: HealthOptions) {
  let previous: string | undefined;
  return () => {
    const db = options.db;
    const now = options.now?.() ?? Date.now();
    const checks: Record<string, Check> = {};
    try {
      if (!db) throw new Error("database unavailable");
      db.query("SELECT count(*) FROM sqlite_schema").get();
      checks.database = { status: "ok" };
    } catch {
      checks.database = { status: "failed", reason: "unavailable" };
    }
    const read = (name: string, query: () => Check) => {
      if (checks.database!.status !== "ok") {
        checks[name] = { status: "skipped", reason: "database_unavailable" };
        return;
      }
      try {
        checks[name] = query();
      } catch {
        // Do not expose SQL errors, file paths, or delivery contents on this public route.
        checks[name] = { status: "failed", reason: "read_failed" };
      }
    };
    const count = (name: string, sql: string, ...params: number[]) =>
      read(name, () => {
        const value = db!.query<{ count: number }, number[]>(sql).get(...params)!.count;
        return { status: value === 0 ? "ok" : "failed", count: value };
      });
    count(
      "jobLeases",
      "SELECT count(*) AS count FROM job WHERE status='running' AND (locked_until IS NULL OR locked_until<=?)",
      now,
    );
    count("deadJobs", "SELECT count(*) AS count FROM job WHERE status='dead'");
    count("deadOutbox", "SELECT count(*) AS count FROM outbox WHERE status='dead'");
    read("runnerHeartbeats", () => {
      const maxAgeMs = RUNNER_ONLINE_MS + RUNNER_LEASE_GRACE_MS;
      const row = db!
        .query<{ total: number; stale: number; oldest: number | null }, [number]>(
          `SELECT count(*) AS total,
             coalesce(sum(last_seen_at IS NULL OR last_seen_at<=?),0) AS stale,
             min(last_seen_at) AS oldest
           FROM runner WHERE status='active' AND revoked_at IS NULL`,
        )
        .get(now - maxAgeMs)!;
      if (row.total === 0) return { status: "skipped", reason: "no_active_runners" };
      return {
        status: row.stale === 0 ? "ok" : "failed",
        count: row.stale,
        ageMs: row.oldest === null ? null : Math.max(0, now - row.oldest),
        maxAgeMs,
      };
    });
    const webhook = (name: string, configured: boolean, sql: string) => {
      if (!configured) {
        checks[name] = { status: "skipped", reason: "not_configured" };
        return;
      }
      read(name, () => {
        const at = db!.query<{ at: number | null }, []>(sql).get()?.at ?? null;
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
    webhook(
      "linearWebhook",
      options.linearWebhook,
      "SELECT cursor_ms AS at FROM sync_cursor WHERE name='linear:webhook'",
    );
    webhook(
      "githubWebhook",
      options.githubWebhook,
      "SELECT max(received_at) AS at FROM github_delivery",
    );
    const failedChecks = Object.keys(checks).filter((name) => checks[name]!.status === "failed");
    const state = failedChecks.join(",");
    if (state !== previous) {
      if (state || previous !== undefined)
        journal(state ? `health: failing checks: ${state}` : "health: healthy");
      previous = state;
    }
    return { ok: failedChecks.length === 0, service: "paws", checks, failedChecks };
  };
}

export type HealthReport = ReturnType<ReturnType<typeof createHealthReport>>;
