import { alertFactsSteps, metricMinutesSteps, type AlertJobRow, type Db } from "../db";

export const ALERTS_PATH = "/api/alerts";

const MINUTE_MS = 60_000;
export const RUNNER_4XX_THRESHOLD = 30;
export const RUNNER_4XX_WINDOW_MS = 10 * MINUTE_MS;
export const REPEATED_FAILURE_ATTEMPTS = 5;
export const REPEATED_FAILURE_WINDOW_MS = 24 * 60 * MINUTE_MS;
export const TEST_TIMEOUT_THRESHOLD = 3;
export const TEST_TIMEOUT_WINDOW_MS = 2 * 60 * MINUTE_MS;
export const DEAD_OUTBOX_WINDOW_MS = 60 * MINUTE_MS;
export const IDLE_FREE_SLOTS = 2;
export const IDLE_WINDOW_MS = 30 * MINUTE_MS;

export type AlertSeverity = "critical" | "warning" | "info";

export type Alert = {
  id: string;
  severity: AlertSeverity;
  title: string;
  detail: string;
  since: number;
  count: number;
};

function runnerHttp4xx(
  rows: readonly { minute: number; labels: Record<string, string>; count: number }[],
): Alert[] {
  const routes = new Map<string, { count: number; since: number }>();
  for (const row of rows) {
    const route = row.labels.route ?? "";
    if (!route.startsWith("/v1/") || row.labels.status_class !== "4xx") continue;
    const found = routes.get(route) ?? { count: 0, since: row.minute };
    routes.set(route, { count: found.count + row.count, since: Math.min(found.since, row.minute) });
  }
  return [...routes]
    .filter(([, { count }]) => count >= RUNNER_4XX_THRESHOLD)
    .map(([route, { count, since }]) => ({
      id: `runner_http_4xx:${route}`,
      severity: "critical",
      title: `Runner route ${route} answered ${count} client errors`,
      detail: `${route} answered ${count} 4xx responses in the last ${RUNNER_4XX_WINDOW_MS / MINUTE_MS} minutes.`,
      since,
      count,
    }));
}

function repeatedFailures(jobs: readonly AlertJobRow[]): Alert[] {
  const byItem = new Map<string, AlertJobRow[]>();
  for (const job of jobs) byItem.set(job.itemId, [...(byItem.get(job.itemId) ?? []), job]);
  const alerts: Alert[] = [];
  for (const [itemId, rows] of byItem) {
    const error = rows[0]?.lastError ?? null;
    if (error === null) continue;
    let attempts = 0;
    let since = Number.POSITIVE_INFINITY;
    for (const row of rows) {
      if (row.status === "done" || row.status === "cancelled" || row.lastError !== error) break;
      attempts += row.status === "running" ? row.attempts - 1 : row.attempts;
      since = Math.min(since, row.at);
    }
    if (attempts < REPEATED_FAILURE_ATTEMPTS) continue;
    const name = rows[0]?.identifier ?? itemId;
    alerts.push({
      id: `repeated_failure:${itemId}`,
      severity: "critical",
      title: `${name} failed ${attempts} times with the same error`,
      detail: error,
      since,
      count: attempts,
    });
  }
  return alerts;
}

function testTimeouts(finishedAt: readonly number[]): Alert[] {
  if (finishedAt.length < TEST_TIMEOUT_THRESHOLD) return [];
  return [
    {
      id: "test_timeouts",
      severity: "warning",
      title: `Closeout's test check timed out ${finishedAt.length} times`,
      detail: `${finishedAt.length} Closeout test steps timed out in the last ${TEST_TIMEOUT_WINDOW_MS / (60 * MINUTE_MS)} hours.`,
      since: Math.min(...finishedAt),
      count: finishedAt.length,
    },
  ];
}

function deadOutbox(
  rows: readonly { id: number; op: string; error: string | null; at: number }[],
): Alert[] {
  const groups = new Map<string, { id: number; op: string; error: string; at: number[] }>();
  for (const row of rows) {
    const error = row.error ?? "No error recorded.";
    const key = JSON.stringify([row.op, error]);
    const found = groups.get(key) ?? { id: row.id, op: row.op, error, at: [] };
    groups.set(key, { ...found, at: [...found.at, row.at] });
  }
  return [...groups.values()].map((group) => ({
    id: `dead_outbox:${group.op}:${group.id}`,
    severity: "warning",
    title: `Outbox ${group.op} delivery went dead`,
    detail: group.error,
    since: Math.min(...group.at),
    count: group.at.length,
  }));
}

function idleCapacity(
  facts: { queuedNow: boolean; lastQueuedAt: number | null; freeSlots: number },
  now: number,
): Alert[] {
  if (facts.freeSlots < IDLE_FREE_SLOTS || facts.queuedNow) return [];
  if (facts.lastQueuedAt !== null && facts.lastQueuedAt > now - IDLE_WINDOW_MS) return [];
  return [
    {
      id: "idle_capacity",
      severity: "info",
      title: `${facts.freeSlots} runner slots are free and nothing is queued`,
      detail: `No item has been queued for ${IDLE_WINDOW_MS / MINUTE_MS} minutes.`,
      since: facts.lastQueuedAt ?? now - IDLE_WINDOW_MS,
      count: facts.freeSlots,
    },
  ];
}

export async function readAlerts(db: Db, now = Date.now()): Promise<Alert[]> {
  const from = Math.floor((now - RUNNER_4XX_WINDOW_MS) / MINUTE_MS) * MINUTE_MS;
  const metrics = await db.run((q) =>
    metricMinutesSteps(q, { names: ["http.request"], from, to: now + MINUTE_MS }),
  );
  const facts = await db.run((q) =>
    alertFactsSteps(q, now, {
      jobs: now - REPEATED_FAILURE_WINDOW_MS,
      testTimeouts: now - TEST_TIMEOUT_WINDOW_MS,
      deadOutbox: now - DEAD_OUTBOX_WINDOW_MS,
    }),
  );
  return [
    ...runnerHttp4xx(metrics),
    ...repeatedFailures(facts.jobs),
    ...testTimeouts(facts.testTimeouts),
    ...deadOutbox(facts.deadOutbox),
    ...idleCapacity(facts, now),
  ].sort((a, b) => b.since - a.since);
}
